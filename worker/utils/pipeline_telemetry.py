"""
情节流水线：结构化 JSON 日志 + 可选 OpenTelemetry（OTLP HTTP）。
环境变量（与 OpenTelemetry 通用约定一致）：
  OTEL_EXPORTER_OTLP_ENDPOINT       例如 http://localhost:4318
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT  完整 traces URL（优先于上一项）
  OTEL_SERVICE_NAME                 默认 agv-worker
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

_initialized = False
_logger = logging.getLogger('agv.pipeline')


def init_otel() -> None:
    """每个 Celery worker 进程调用一次。"""
    global _initialized
    if _initialized:
        return
    try:
        import opentelemetry.trace  # noqa: F401
    except ImportError:
        _initialized = True
        return
    endpoint = (os.getenv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') or '').strip()
    if not endpoint:
        base = (os.getenv('OTEL_EXPORTER_OTLP_ENDPOINT') or '').strip().rstrip('/')
        endpoint = f'{base}/v1/traces' if base else ''
    if not endpoint:
        _initialized = True
        return
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        service = os.getenv('OTEL_SERVICE_NAME', 'agv-worker')
        provider = TracerProvider(resource=Resource.create({'service.name': service}))
        exporter = OTLPSpanExporter(endpoint=endpoint)
        provider.add_span_processor(BatchSpanProcessor(exporter))
        trace.set_tracer_provider(provider)
    except Exception as exc:  # noqa: BLE001
        _logger.warning('OpenTelemetry init skipped: %s', exc)
    _initialized = True


def log_pipeline_event(payload: dict[str, Any]) -> None:
    line = json.dumps(
        {'ts': datetime.now(timezone.utc).isoformat(), 'component': 'agv.pipeline', **payload},
        ensure_ascii=False,
        default=str,
    )
    print(line, flush=True)


def _ensure_aware_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _ms_between(a: datetime, b: datetime) -> int:
    return int((_ensure_aware_utc(b) - _ensure_aware_utc(a)).total_seconds() * 1000)


def record_story_analysis_completed(db, episode_id: str, task_id: str, project_id: str, now: datetime) -> None:
    """情节解析完成：写入 episodes.pipelineMetrics + 日志 + Span。"""
    task = db.tasks.find_one({'taskId': task_id}, {'createdAt': 1})
    ep = db.episodes.find_one({'episodeId': episode_id}, {'pipelineMetrics': 1})
    pm = (ep or {}).get('pipelineMetrics') or {}
    t0 = pm.get('storyAnalysisSubmittedAt') or (task or {}).get('createdAt') or now
    duration_ms = _ms_between(t0, now)

    db.episodes.update_one(
        {'episodeId': episode_id},
        {'$set': {
            'pipelineMetrics.storyAnalysisCompletedAt': now,
            'pipelineMetrics.storyAnalysisDurationMs': duration_ms,
            'updatedAt': now,
        }},
    )

    log_pipeline_event({
        'event': 'story_analysis_completed',
        'episodeId': episode_id,
        'projectId': project_id,
        'taskId': task_id,
        'durationMs': duration_ms,
        'phase': 'novel_input_to_story_parsed',
    })

    try:
        from opentelemetry import trace

        tracer = trace.get_tracer('agv.pipeline', '1.0.0')
        with tracer.start_as_current_span('pipeline.story_analysis.completed') as span:
            span.set_attribute('episode.id', episode_id)
            span.set_attribute('project.id', project_id)
            span.set_attribute('task.id', task_id)
            span.set_attribute('duration_ms', duration_ms)
    except Exception:  # noqa: BLE001
        pass


def maybe_record_first_beat_frame_image(
    db,
    episode_id: str,
    project_id: str,
    *,
    slot: str,
    now: datetime,
) -> None:
    """首个「首尾帧方案」的 first_frame 生图成功时：相对情节解析完成点的耗时。"""
    if slot != 'first_frame':
        return
    ep = db.episodes.find_one({'episodeId': episode_id}, {'pipelineMetrics': 1})
    pm = (ep or {}).get('pipelineMetrics') or {}
    if pm.get('firstBeatFrameImageCompletedAt'):
        return
    story_done = pm.get('storyAnalysisCompletedAt')
    if not story_done:
        return

    duration_ms = _ms_between(story_done, now)
    db.episodes.update_one(
        {'episodeId': episode_id},
        {'$set': {
            'pipelineMetrics.firstBeatFrameImageCompletedAt': now,
            'pipelineMetrics.storyToFirstFrameImageMs': duration_ms,
            'updatedAt': now,
        }},
    )

    log_pipeline_event({
        'event': 'first_beat_first_frame_image_completed',
        'episodeId': episode_id,
        'projectId': project_id,
        'durationMs': duration_ms,
        'phase': 'story_parsed_to_first_keyframe_image',
    })

    try:
        from opentelemetry import trace

        tracer = trace.get_tracer('agv.pipeline', '1.0.0')
        with tracer.start_as_current_span('pipeline.first_beat_first_frame.completed') as span:
            span.set_attribute('episode.id', episode_id)
            span.set_attribute('project.id', project_id)
            span.set_attribute('duration_ms', duration_ms)
    except Exception:  # noqa: BLE001
        pass
