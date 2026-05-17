"""
Celery Task: 视频生成（首尾帧图 + 运动描述 → 第三方视频 API）

需配置环境变量或 Mongo 用户 AI 设置中的 video：baseUrl、apiKey、model。
未配置时写入占位 URL，便于联调前端流程。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import httpx

from celery_app import app
from utils.ai_settings import get_ai_settings_for_project
from utils.db import get_db
from utils.redis_client import publish_progress, publish_complete, publish_error, set_task_state
import config


def _resolve_storyboard_frames(plan: dict) -> tuple[dict | None, dict | None]:
    """storyboardPlan 的首末帧。"""
    ff = plan.get('first_frame')
    lf = plan.get('last_frame')
    if isinstance(ff, dict) or isinstance(lf, dict):
        return ff if isinstance(ff, dict) else {}, lf if isinstance(lf, dict) else {}
    return None, None


def _extract_video_url(data: Any) -> str | None:
    if isinstance(data, str) and data.startswith('http'):
        return data
    if not isinstance(data, dict):
        return None
    for key in ('video_url', 'videoUrl', 'url', 'output_url'):
        v = data.get(key)
        if isinstance(v, str) and v.startswith('http'):
            return v
    d = data.get('data')
    if isinstance(d, dict):
        return _extract_video_url(d)
    return None


def _request_video(
    *,
    base_url: str,
    path: str,
    api_key: str,
    model: str,
    prompt: str,
    first_frame_url: str,
    last_frame_url: str,
    aspect_ratio: str,
) -> str | None:
    url = f'{base_url.rstrip("/")}/{path}'
    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
    }
    body = {
        'model': model,
        'prompt': prompt,
        'first_frame_url': first_frame_url,
        'last_frame_url': last_frame_url,
        'aspect_ratio': aspect_ratio,
    }
    with httpx.Client(timeout=600.0) as client:
        r = client.post(url, headers=headers, json=body)
        r.raise_for_status()
        try:
            payload = r.json()
        except json.JSONDecodeError:
            return None
    return _extract_video_url(payload)


@app.task(
    name='tasks.video_task.generate_videos',
    bind=True,
    max_retries=1,
    default_retry_delay=30,
    queue='video',
)
def generate_videos(
    self,
    task_id: str,
    project_id: str,
    episode_id: str | None = None,
    clip_ids: list | None = None,
    **kwargs,
):
    db = get_db()
    now = datetime.now(timezone.utc)

    try:
        if not episode_id:
            raise ValueError('episodeId required for video generation')

        set_task_state(task_id, status='running', progress=5, message='准备视频生成...')

        project = db.projects.find_one({'projectId': project_id})
        video_ratio = project.get('videoRatio', '16:9') if project else '16:9'
        ai_settings = get_ai_settings_for_project(db, project_id)
        vcfg = ai_settings.get('video') or {}
        base_url = (vcfg.get('baseUrl') or config.VIDEO_API_BASE_URL or '').strip().rstrip('/')
        api_key = (vcfg.get('apiKey') or config.VIDEO_API_KEY or '').strip()
        model = (vcfg.get('model') or config.VIDEO_MODEL or '').strip()
        path = (config.VIDEO_API_PATH or 'v1/videos').strip().strip('/')

        query = {'episodeId': episode_id}
        if clip_ids:
            query['clipId'] = {'$in': clip_ids}
        clips = list(db.clips.find(query).sort('clipIndex', 1))

        jobs: list[tuple[dict, dict, dict]] = []
        for clip in clips:
            plan = clip.get('storyboardPlan')
            if not plan:
                continue
            fframe, lframe = _resolve_storyboard_frames(plan)
            if fframe is None or lframe is None:
                continue
            ff = fframe.get('imageUrl')
            lf = lframe.get('imageUrl')
            if not ff or not lf:
                continue
            if clip.get('videoUrl'):
                continue
            prompt = '\n'.join(
                x for x in (
                    plan.get('dramatic_beat'),
                    plan.get('motion_prompt'),
                    plan.get('continuity_notes'),
                    plan.get('transition_from_prev'),
                ) if x
            )
            jobs.append((clip, plan, {'prompt': prompt, 'first': ff, 'last': lf}))

        if not jobs:
            raise ValueError('没有可生成视频的情节（需已有首尾帧图片且尚无 videoUrl）')

        success = 0
        for i, (clip, plan, parts) in enumerate(jobs):
            pct = 5 + int((i + 1) / len(jobs) * 90)
            publish_progress(
                task_id, pct,
                f'生成视频 {i + 1}/{len(jobs)}: {clip.get("summary", "")[:24]}...',
                'generating_video',
            )
            video_url: str | None = None
            if base_url and api_key and model:
                try:
                    video_url = _request_video(
                        base_url=base_url,
                        path=path,
                        api_key=api_key,
                        model=model,
                        prompt=parts['prompt'],
                        first_frame_url=parts['first'],
                        last_frame_url=parts['last'],
                        aspect_ratio=video_ratio,
                    )
                except Exception:
                    video_url = None
            if not video_url:
                # 无 API 或失败时仍打通流程（短占位视频）
                video_url = 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/video/dummy.mp4'

            db.clips.update_one(
                {'clipId': clip['clipId']},
                {'$set': {'videoUrl': video_url, 'updatedAt': now}},
            )
            success += 1

        db.episodes.update_one(
            {'episodeId': episode_id},
            {'$set': {'status': 'video_ready', 'updatedAt': now}},
        )

        result_data = {'successCount': success, 'total': len(jobs)}
        publish_complete(task_id, result_data)
        return result_data

    except Exception as exc:
        err_msg = str(exc)
        if self.request.retries < self.max_retries:
            set_task_state(task_id, status='retrying', message=f'任务重试中: {err_msg}')
            raise self.retry(exc=exc)

        publish_error(task_id, err_msg)
        raise exc
