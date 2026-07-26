"""
Celery Task: 字幕辅助处理

功能：
  1. 抽取视频帧预览图（用于前端帧网格展示）
  2. 使用 LLM 把自然语言解析成带时间轴的字幕数组
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from typing import Any

import httpx

from celery_app import app
from utils.ai_settings import get_ai_settings_for_project
from utils.db import get_db
from utils.json_utils import safe_parse_json
from utils.redis_client import publish_complete, publish_error, publish_progress, set_task_state
from utils.reference_assets import sign_oss_url, upload_file_to_oss
from skills.llm_chat import chat_completion_text


def _clean_http_url(value: Any) -> str:
    if not isinstance(value, str):
        return ''
    safe = value.strip()
    return safe if re.match(r'^https?://', safe) else ''


def _ffmpeg_binary() -> str:
    custom = os.getenv('FFMPEG_BIN', '').strip()
    if custom:
        return custom
    system_bin = shutil.which('ffmpeg') or ''
    if system_bin:
        return system_bin
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return ''


def _get_video_duration(video_path: str) -> float:
    """获取视频时长（秒）"""
    ffmpeg_bin = _ffmpeg_binary()
    if not ffmpeg_bin:
        return 10.0

    try:
        cmd = [
            ffmpeg_bin, '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=nw=1:nk=1',
            video_path,
        ]
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
        if result.returncode == 0:
            return float(result.stdout.strip() or 10)
    except Exception:
        pass
    return 10.0


def _download_to_temp_file(url: str, suffix: str) -> tuple[str, str]:
    fd, temp_path = tempfile.mkstemp(prefix='agv_sub_', suffix=suffix)
    os.close(fd)
    try:
        with httpx.Client(timeout=120.0, follow_redirects=True) as client:
            with client.stream('GET', url) as resp:
                resp.raise_for_status()
                content_type = (resp.headers.get('content-type') or '').split(';', 1)[0].strip().lower()
                with open(temp_path, 'wb') as fh:
                    for chunk in resp.iter_bytes():
                        if chunk:
                            fh.write(chunk)
        return temp_path, content_type
    except Exception:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def _extract_frame_at(video_path: str, timestamp: float, output_path: str, width: int = 320) -> None:
    """抽取指定时间点的视频帧并缩放"""
    ffmpeg_bin = _ffmpeg_binary()
    if not ffmpeg_bin:
        raise RuntimeError('ffmpeg 不可用')

    cmd = [
        ffmpeg_bin, '-y', '-ss', str(timestamp),
        '-i', video_path,
        '-vframes', '1',
        '-q:v', '2',
        '-vf', f'scale={width}:-2',
        output_path,
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60)
    if proc.returncode != 0 or not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
        detail = (proc.stderr or proc.stdout or '').strip()[-500:]
        raise RuntimeError(f'ffmpeg 抽帧失败: {detail or "unknown error"}')


@app.task(
    name='tasks.subtitle_task.extract_video_frames',
    bind=True,
    max_retries=1,
    default_retry_delay=30,
    queue='video',
)
def extract_video_frames(
    self,
    task_id: str,
    project_id: str,
    video_url: str,
    options: dict | None = None,
    **kwargs,
):
    """
    抽取视频关键帧预览图

    参数:
      - video_url: 视频 URL
      - options:
        - maxFrames: 最多抽几帧（默认 12）
        - width: 帧宽度（默认 320）
    """
    set_task_state(task_id, status='running', progress=5, message='准备视频抽帧...')

    try:
        opts = options or {}
        max_frames = int(opts.get('maxFrames', 12))
        width = int(opts.get('width', 320))

        safe_url = _clean_http_url(video_url)
        if not safe_url:
            raise ValueError('视频 URL 无效')

        publish_progress(task_id, 10, '下载视频...', 'downloading_video')
        video_path, _ = _download_to_temp_file(safe_url, '.mp4')

        try:
            duration = _get_video_duration(video_path)
            if duration <= 0:
                duration = 10.0

            # 均匀分布时间点
            if max_frames <= 1:
                timestamps = [0.0]
            else:
                step = duration / max_frames
                timestamps = [round(i * step, 2) for i in range(max_frames)]

            frames = []
            total = len(timestamps)
            for idx, ts in enumerate(timestamps):
                pct = 20 + int((idx + 1) / total * 70)
                publish_progress(task_id, pct, f'抽取帧 {idx + 1}/{total}...', 'extracting_frames')

                fd, frame_path = tempfile.mkstemp(prefix='agv_frame_', suffix='.jpg')
                os.close(fd)
                try:
                    _extract_frame_at(video_path, ts, frame_path, width)

                    # 上传 OSS
                    uploaded = upload_file_to_oss(
                        frame_path,
                        file_name=f'frame_{idx:03d}.jpg',
                        sub_dir=f'videos/frames/{task_id}',
                        content_type='image/jpeg',
                    )

                    frames.append({
                        'index': idx,
                        'timestamp': ts,
                        'duration': duration,
                        'imageUrl': uploaded['url'],
                        'objectKey': uploaded['objectKey'],
                    })
                finally:
                    try:
                        os.unlink(frame_path)
                    except OSError:
                        pass

            result = {
                'videoUrl': safe_url,
                'duration': duration,
                'frames': frames,
                'frameCount': len(frames),
            }
            publish_complete(task_id, result)
            return result
        finally:
            try:
                os.unlink(video_path)
            except OSError:
                pass

    except Exception as exc:
        err_msg = str(exc)
        if self.request.retries < self.max_retries:
            set_task_state(task_id, status='retrying', message=f'任务重试中: {err_msg}')
            raise self.retry(exc=exc)

        publish_error(task_id, err_msg)
        raise exc


def _format_time_for_prompt(seconds: float) -> str:
    """把时间转为 mm:ss 格式用于提示"""
    m = int(seconds) // 60
    s = int(seconds) % 60
    return f'{m}:{s:02d}'


def _parse_subtitle_language(
    video_duration: float,
    language_text: str,
    ai_settings: dict,
) -> list[dict]:
    """用 LLM 把自然语言解析成时间轴字幕"""
    system_prompt = (
        '你是一个视频字幕时间轴解析助手。'
        '用户会用自然语言描述在视频的什么时刻显示什么字幕。'
        '请把描述解析为严格 JSON 数组，每个元素包含：\n'
        '{\n'
        '  "start": 开始时间秒数（float）,\n'
        '  "end": 结束时间秒数（float）,\n'
        '  "text": "字幕文本",\n'
        '  "position": {"vertical": "bottom|middle|top", "align": "start|center|end"}\n'
        '}\n'
        '规则：\n'
        '1. 时间必须在 0 到视频时长之间\n'
        '2. 时间段不要重叠\n'
        '3. 默认位置 vertical=bottom, align=center\n'
        '4. 只能返回 JSON 数组，不要解释'
    )

    user_prompt = (
        f'视频总时长：{video_duration:.1f} 秒\n'
        f'用户描述："{language_text}"\n'
        '请输出 JSON 数组。'
    )

    raw = chat_completion_text(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        ai_settings=ai_settings,
        max_tokens=2048,
        temperature=0.2,
    )

    parsed = safe_parse_json(raw)
    if not isinstance(parsed, list):
        raise ValueError(f'LLM 返回不是数组: {raw[:200]}')

    cues = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        start = float(item.get('start', 0))
        end = float(item.get('end', video_duration))
        text = str(item.get('text', '')).strip()
        if not text:
            continue
        if start < 0:
            start = 0
        if end > video_duration:
            end = video_duration
        if end <= start:
            end = min(start + 3, video_duration)

        position = item.get('position') or {}
        cues.append({
            'start': round(start, 2),
            'end': round(end, 2),
            'text': text,
            'position': {
                'vertical': str(position.get('vertical', 'bottom')).lower() if isinstance(position, dict) else 'bottom',
                'align': str(position.get('align', 'center')).lower() if isinstance(position, dict) else 'center',
            },
        })

    return cues


@app.task(
    name='tasks.subtitle_task.parse_subtitle_language',
    bind=True,
    max_retries=1,
    default_retry_delay=30,
    queue='storyboard',
)
def parse_subtitle_language(
    self,
    task_id: str,
    project_id: str,
    video_duration: float,
    language_text: str,
    **kwargs,
):
    """
    把自然语言描述解析为带时间轴的字幕数组

    参数:
      - video_duration: 视频总时长（秒）
      - language_text: 用户自然语言描述
    """
    set_task_state(task_id, status='running', progress=10, message='准备解析字幕描述...')

    try:
        db = get_db()
        ai_settings = get_ai_settings_for_project(db, project_id)

        publish_progress(task_id, 50, '调用 LLM 解析自然语言...', 'parsing_language')
        cues = _parse_subtitle_language(video_duration, language_text, ai_settings)

        publish_progress(task_id, 90, '整理字幕时间轴...', 'finalizing')

        result = {
            'cues': cues,
            'count': len(cues),
            'videoDuration': video_duration,
            'languageText': language_text,
        }
        publish_complete(task_id, result)
        return result

    except Exception as exc:
        err_msg = str(exc)
        if self.request.retries < self.max_retries:
            set_task_state(task_id, status='retrying', message=f'任务重试中: {err_msg}')
            raise self.retry(exc=exc)

        publish_error(task_id, err_msg)
        raise exc
