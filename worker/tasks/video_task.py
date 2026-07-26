"""
Celery Task: 通过 Ark / Seedance 内容生成任务创建视频。

输入素材顺序固定为：
1. text（基于 storyboardPlan.video_prompt 重组）
2. 首帧图（图片1，必填）
3. 场景图（可选）
4. 角色图（按 clip.characters 顺序）
5. 参考视频（clip.videoReferenceAssets.videoUrls）
6. 参考音频（clip.videoReferenceAssets.audioUrls）
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from typing import Any, Callable

import httpx

from celery_app import app
from utils.ai_settings import get_ai_settings_for_project
from utils.db import get_db
from utils.redis_client import publish_complete, publish_error, publish_progress, set_task_state
from utils.reference_assets import (
    character_reference_url,
    location_reference_url,
    sign_oss_url,
    upload_file_to_oss,
    upload_image_data_url_to_oss,
)


def _clean_http_url(value: Any) -> str:
    if not isinstance(value, str):
        return ''
    safe = value.strip()
    return safe if re.match(r'^https?://', safe) else ''


def _is_data_image_url(value: Any) -> bool:
    return isinstance(value, str) and value.strip().startswith('data:image/')


def _default_reference_image_resolver(value: Any, _file_name: str, _sub_dir: str) -> str:
    return _clean_http_url(value)


def _resolve_reference_image_url(value: Any, file_name: str, sub_dir: str) -> str:
    http_url = _clean_http_url(value)
    if http_url:
        return _clean_http_url(sign_oss_url(http_url) or http_url)
    if _is_data_image_url(value):
        uploaded = upload_image_data_url_to_oss(str(value), file_name, sub_dir)
        return _clean_http_url(uploaded.get('url'))
    return ''


def _extract_video_url(data: Any) -> str | None:
    if isinstance(data, str):
        safe = data.strip()
        return safe if safe.startswith('http') else None
    if isinstance(data, list):
        for item in data:
            found = _extract_video_url(item)
            if found:
                return found
        return None
    if not isinstance(data, dict):
        return None

    for key in ('video_url', 'videoUrl', 'url', 'output_url', 'outputUrl', 'file_url', 'source_url'):
        value = data.get(key)
        if isinstance(value, str) and value.strip().startswith('http'):
            return value.strip()

    for value in data.values():
        found = _extract_video_url(value)
        if found:
            return found
    return None


def _extract_task_id(data: Any) -> str | None:
    if isinstance(data, list):
        for item in data:
            found = _extract_task_id(item)
            if found:
                return found
        return None
    if not isinstance(data, dict):
        return None

    for key in ('task_id', 'taskId', 'id'):
        value = data.get(key)
        if isinstance(value, str):
            safe = value.strip()
            if safe and not safe.startswith('http'):
                return safe

    for value in data.values():
        found = _extract_task_id(value)
        if found:
            return found
    return None


def _extract_task_status(data: Any) -> str:
    if isinstance(data, list):
        for item in data:
            found = _extract_task_status(item)
            if found:
                return found
        return ''
    if not isinstance(data, dict):
        return ''

    for key in ('status', 'state'):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    for value in data.values():
        found = _extract_task_status(value)
        if found:
            return found
    return ''


def _video_reference_assets(clip: dict) -> dict[str, list[str]]:
    src = clip.get('videoReferenceAssets') if isinstance(clip, dict) else None
    assets = src if isinstance(src, dict) else {}

    def normalize(key: str) -> list[str]:
        values = assets.get(key)
        if not isinstance(values, list):
            return []
        return [str(item).strip() for item in values if isinstance(item, str) and str(item).strip()]

    return {
        'videoUrls': normalize('videoUrls'),
        'audioUrls': normalize('audioUrls'),
    }


def _resume_provider_task_id(clip: dict) -> str:
    provider = clip.get('videoGeneration') if isinstance(clip.get('videoGeneration'), dict) else {}
    status = str(provider.get('status') or '').strip().lower()
    provider_task_id = str(provider.get('providerTaskId') or '').strip()
    if status in {'submitted', 'running', 'processing', 'uploading'} and provider_task_id:
        return provider_task_id
    return ''


def _build_ark_text(video_prompt: str, mapping_lines: list[str]) -> str:
    prompt = (video_prompt or '').strip()
    if not prompt:
        return ''
    if not mapping_lines:
        return prompt
    return f'素材参考：{"；".join(mapping_lines)}。\n\n{prompt}'


def _build_clip_content(
    project: dict | None,
    clip: dict,
    plan: dict,
    resolve_image_url: Callable[[Any, str, str], str] | None = None,
    previous_clip: dict | None = None,
) -> tuple[list[dict[str, Any]], str, list[str]]:
    errors: list[str] = []
    content: list[dict[str, Any]] = []
    mapping_lines: list[str] = []
    image_index = 0
    image_resolver = resolve_image_url or _default_reference_image_resolver
    clip_id = str(clip.get('clipId') or 'clip')

    def append_reference_image(url: str, label: str) -> None:
        nonlocal image_index
        content.append({
            'type': 'image_url',
            'image_url': {'url': url},
            'role': 'reference_image',
        })
        image_index += 1
        mapping_lines.append(f'图片{image_index}为{label}')

    first_frame = plan.get('first_frame') if isinstance(plan.get('first_frame'), dict) else {}
    first_frame_url = image_resolver(first_frame.get('imageUrl'), f'{clip_id}_first_frame.jpg', 'clips')
    if not first_frame_url:
        errors.append('缺首帧图片')
    else:
        append_reference_image(first_frame_url, '首帧参考')

    continuity_url = image_resolver(first_frame.get('continuityImageUrl'), f'{clip_id}_continuity.jpg', 'clips')
    # 只有当首帧自身没有连续性图（即不是上一段尾帧的直接延续）时，
    # 才显式补传上一段尾帧图；避免传重复内容。
    prev_tail_url = ''
    if not continuity_url:
        prev_plan = previous_clip.get('storyboardPlan') if isinstance(previous_clip, dict) else {}
        prev_last = prev_plan.get('last_frame') if isinstance(prev_plan, dict) and isinstance(prev_plan.get('last_frame'), dict) else {}
        prev_tail_url = image_resolver(
            prev_last.get('imageUrl'),
            f'{clip_id}_previous_last_frame.jpg',
            'clips',
        )
    prev_tail_url = continuity_url or prev_tail_url
    if prev_tail_url and prev_tail_url != first_frame_url:
        append_reference_image(prev_tail_url, '上一情节尾帧连续性参考')

    scene_url = image_resolver(location_reference_url(project, clip), f'{clip_id}_scene.jpg', 'references')
    if scene_url:
        append_reference_image(scene_url, '场景参考')

    seen_characters: set[str] = set()
    for name in clip.get('characters') or []:
        safe_name = (name or '').strip()
        if not safe_name or safe_name in seen_characters:
            continue
        seen_characters.add(safe_name)
        char_url = image_resolver(
            character_reference_url(project, clip, safe_name),
            f'{clip_id}_{safe_name}.jpg',
            'references',
        )
        if not char_url:
            errors.append(f'角色 {safe_name} 缺参考图')
            continue
        append_reference_image(char_url, f'角色{safe_name}参考')

    assets = _video_reference_assets(clip)
    video_idx = 0
    for url in assets['videoUrls']:
        clean_url = _clean_http_url(url)
        if not clean_url:
            errors.append('存在非法参考视频 URL')
            continue
        video_idx += 1
        content.append({
            'type': 'video_url',
            'video_url': {'url': clean_url},
            'role': 'reference_video',
        })
        mapping_lines.append(f'视频{video_idx}为运镜/视角参考')

    audio_idx = 0
    for url in assets['audioUrls']:
        clean_url = _clean_http_url(url)
        if not clean_url:
            errors.append('存在非法参考音频 URL')
            continue
        audio_idx += 1
        content.append({
            'type': 'audio_url',
            'audio_url': {'url': clean_url},
            'role': 'reference_audio',
        })
        mapping_lines.append(f'音频{audio_idx}为背景音乐参考')

    prompt = _build_ark_text(str(plan.get('video_prompt') or ''), mapping_lines)
    if not prompt:
        errors.append('缺视频 Prompt')

    return content, prompt, errors


def _request_ark_video(
    *,
    base_url: str,
    api_key: str,
    model: str,
    content: list[dict[str, Any]],
    aspect_ratio: str,
    duration: int,
    resolution: str = '480p',
    generate_audio: bool = False,
    resume_task_id: str | None = None,
    on_submitted: Callable[[str], None] | None = None,
    on_poll: Callable[[str, int, str], None] | None = None,
) -> tuple[str, str]:
    submit_url = f'{base_url.rstrip("/")}/contents/generations/tasks'
    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
    }
    body = {
        'model': model,
        'content': content,
        'generate_audio': generate_audio,
        'ratio': aspect_ratio,
        'resolution': resolution,
        'duration': duration if duration > 0 else 5,
        'watermark': False,
    }

    with httpx.Client(timeout=600.0) as client:
        task_id = (resume_task_id or '').strip()
        if task_id:
            ready_url = ''
        else:
            submit_resp = client.post(submit_url, headers=headers, json=body)
            submit_resp.raise_for_status()
            submit_payload = submit_resp.json()

            ready_url = _extract_video_url(submit_payload)
            task_id = _extract_task_id(submit_payload) or ''
            if task_id and on_submitted:
                on_submitted(task_id)
            if ready_url:
                return ready_url, task_id
            if not task_id:
                raise ValueError('Ark 未返回 taskId')

        query_url = f'{submit_url}/{task_id}'
        for attempt in range(1, 121):
            time.sleep(5)
            query_resp = client.get(query_url, headers=headers)
            query_resp.raise_for_status()
            query_payload = query_resp.json()

            ready_url = _extract_video_url(query_payload)
            if ready_url:
                return ready_url, task_id

            status = _extract_task_status(query_payload).lower()
            if on_poll:
                on_poll(status or 'running', attempt, task_id)
            if status in {'failed', 'error', 'canceled', 'cancelled'}:
                raise ValueError(f'Ark video task failed: {status}')
            if status in {'succeeded', 'completed', 'success', 'done', 'finished'}:
                break

    raise ValueError('Ark 任务完成但未返回视频 URL')


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


def _download_to_temp_file(url: str, suffix: str) -> tuple[str, str]:
    fd, temp_path = tempfile.mkstemp(prefix='agv_', suffix=suffix)
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


def _extract_last_frame_data_url(video_url: str) -> str:
    ffmpeg_bin = _ffmpeg_binary()
    if not ffmpeg_bin:
        raise RuntimeError('ffmpeg 不可用，无法自动抽取上一情节视频尾帧')

    signed_video_url = _clean_http_url(sign_oss_url(video_url) or video_url)
    if not signed_video_url:
        raise RuntimeError('视频 URL 无效，无法自动抽取上一情节视频尾帧')

    input_path, _ = _download_to_temp_file(signed_video_url, '.mp4')
    out_fd, out_path = tempfile.mkstemp(prefix='agv_tail_', suffix='.jpg')
    os.close(out_fd)
    try:
        cmd = [
            ffmpeg_bin,
            '-y',
            '-sseof',
            '-0.25',
            '-i',
            input_path,
            '-frames:v',
            '1',
            '-q:v',
            '2',
            out_path,
        ]
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=120,
        )
        if proc.returncode != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
            detail = (proc.stderr or proc.stdout or '').strip()[-500:]
            raise RuntimeError(f'ffmpeg 抽帧失败: {detail or "unknown error"}')

        with open(out_path, 'rb') as fh:
            encoded = base64.b64encode(fh.read()).decode('utf-8')
        return f'data:image/jpeg;base64,{encoded}'
    finally:
        for path in (input_path, out_path):
            try:
                os.unlink(path)
            except OSError:
                pass


def _persist_video_to_oss(clip: dict, source_url: str) -> dict[str, str]:
    safe_source_url = _clean_http_url(source_url)
    if not safe_source_url:
        raise ValueError('Ark 未返回可用视频 URL')

    clip_id = str(clip.get('clipId') or 'clip')
    project_id = str(clip.get('projectId') or 'project')
    episode_id = str(clip.get('episodeId') or 'episode')
    temp_path, content_type = _download_to_temp_file(safe_source_url, '.mp4')
    try:
        transcoded_path = _transcode_to_480p(temp_path)
        upload_path = transcoded_path or temp_path
        uploaded = upload_file_to_oss(
            upload_path,
            file_name=f'{clip_id}.mp4',
            sub_dir=f'videos/{project_id}/{episode_id}',
            content_type=content_type or 'video/mp4',
        )
        final_url = _clean_http_url(uploaded.get('url'))
        object_key = str(uploaded.get('objectKey') or '').strip()
        if not final_url:
            raise RuntimeError('视频转存 OSS 成功但未返回可用 URL')
        if not object_key:
            raise RuntimeError('视频转存 OSS 成功但未返回 objectKey')
        return {'url': final_url, 'objectKey': object_key}
    finally:
        for path in (temp_path,):
            try:
                os.unlink(path)
            except OSError:
                pass
        if transcoded_path and transcoded_path != temp_path:
            try:
                os.unlink(transcoded_path)
            except OSError:
                pass


def _propagate_continuity_frame(db, clip: dict, video_url: str, now) -> dict[str, Any] | None:
    episode_id = clip.get('episodeId')
    clip_index = clip.get('clipIndex')
    if not episode_id or not isinstance(clip_index, int):
        return None

    next_clip = db.clips.find_one({
        'episodeId': episode_id,
        'clipIndex': clip_index + 1,
        'isActive': {'$ne': False},
    })
    if not next_clip:
        return None

    tail_frame_data_url = _extract_last_frame_data_url(video_url)
    uploaded = upload_image_data_url_to_oss(
        tail_frame_data_url,
        f'{next_clip["clipId"]}_continuity.jpg',
        'clips',
    )
    continuity_url = _clean_http_url(uploaded.get('url'))
    if not continuity_url:
        raise RuntimeError('连续性尾帧上传成功但未返回可用 URL')

    db.clips.update_one(
        {'clipId': next_clip['clipId']},
        {'$set': {
            'storyboardPlan.first_frame.imageUrl': continuity_url,
            'storyboardPlan.first_frame.continuityImageUrl': continuity_url,
            'storyboardPlan.first_frame.continuitySourceClipId': clip.get('clipId'),
            'updatedAt': now,
        }},
    )
    return {
        'targetClipId': next_clip['clipId'],
        'sourceClipId': clip.get('clipId'),
        'continuityImageUrl': continuity_url,
    }


def _transcode_to_480p(input_path: str) -> str | None:
    """将 Ark 返回的视频统一转码为 480P（高度 480，宽度按原始比例缩放）。"""
    ffmpeg_bin = _ffmpeg_binary()
    if not ffmpeg_bin:
        return None

    out_fd, out_path = tempfile.mkstemp(prefix='agv_480p_', suffix='.mp4')
    os.close(out_fd)
    cmd = [
        ffmpeg_bin,
        '-y',
        '-i',
        input_path,
        '-vf',
        'scale=-2:480',
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '23',
        '-c:a',
        'copy',
        '-movflags',
        '+faststart',
        out_path,
    ]
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=180,
    )
    if proc.returncode != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        detail = (proc.stderr or proc.stdout or '').strip()[-500:]
        raise RuntimeError(f'ffmpeg 480P 转码失败: {detail or "unknown error"}')
    return out_path


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

        set_task_state(task_id, status='running', progress=5, message='准备 Ark 视频生成...')

        project = db.projects.find_one({'projectId': project_id})
        video_ratio = project.get('videoRatio', '16:9') if project else '16:9'
        ai_settings = get_ai_settings_for_project(db, project_id)
        vcfg = ai_settings.get('video') or {}
        base_url = str(vcfg.get('baseUrl') or '').strip().rstrip('/')
        api_key = str(vcfg.get('apiKey') or '').strip()
        model = str(vcfg.get('model') or '').strip()
        resolution = str(vcfg.get('resolution') or '480p').strip()
        generate_audio = bool(vcfg.get('generateAudio', False))

        if not base_url or not api_key or not model:
            raise ValueError('未配置可用的 Ark 视频设置（baseUrl/apiKey/model）')

        query = {'episodeId': episode_id, 'isActive': {'$ne': False}}
        if clip_ids:
            query['clipId'] = {'$in': clip_ids}
        clips = list(db.clips.find(query).sort('clipIndex', 1))

        jobs: list[tuple[dict, list[dict[str, Any]], int]] = []
        build_errors: list[str] = []

        for i, clip in enumerate(clips):
            plan = clip.get('storyboardPlan')
            if not isinstance(plan, dict):
                build_errors.append(f'情节 {clip.get("clipIndex", 0) + 1}: 缺 storyboardPlan')
                continue

            prev_clip = clips[i - 1] if i > 0 else None
            content_refs, prompt, errors = _build_clip_content(
                project,
                clip,
                plan,
                resolve_image_url=_resolve_reference_image_url,
                previous_clip=prev_clip,
            )
            if errors:
                build_errors.append(f'情节 {clip.get("clipIndex", 0) + 1}: {"；".join(errors)}')
                continue

            first_frame = plan.get('first_frame') if isinstance(plan.get('first_frame'), dict) else {}
            if _is_data_image_url(first_frame.get('imageUrl')) and content_refs:
                first_ref = content_refs[0]
                uploaded_first_frame_url = _clean_http_url(first_ref.get('image_url', {}).get('url'))
                if uploaded_first_frame_url:
                    db.clips.update_one(
                        {'clipId': clip['clipId']},
                        {'$set': {'storyboardPlan.first_frame.imageUrl': uploaded_first_frame_url, 'updatedAt': now}},
                    )
                    first_frame['imageUrl'] = uploaded_first_frame_url

            content = [{'type': 'text', 'text': prompt}, *content_refs]
            # 默认按 5 秒生成以降低单次成本；若 clip 指定了 duration 仍优先使用
            duration = int(clip.get('duration') or 5)
            if duration < 2:
                duration = 5
            elif duration > 15:
                duration = 15
            jobs.append((clip, content, duration))

        if not jobs:
            raise ValueError('没有可生成视频的情节：' + ' | '.join(build_errors[:8]))

        success = 0
        run_errors = list(build_errors)
        continuity_updates: list[dict[str, Any]] = []
        continuity_errors: list[str] = []

        for i, (clip, content, duration) in enumerate(jobs):
            pct = 5 + int((i + 1) / len(jobs) * 90)
            publish_progress(
                task_id,
                pct,
                f'生成视频 {i + 1}/{len(jobs)}: {clip.get("summary", "")[:24]}...',
                'generating_video',
            )
            try:
                resume_provider_task_id = _resume_provider_task_id(clip)
                provider_task_state = {'task_id': resume_provider_task_id}
                last_poll_emit = {'attempt': 0, 'status': ''}

                def persist_provider_state(
                    provider_task_id: str,
                    provider_status: str,
                    extra_fields: dict[str, Any] | None = None,
                ) -> None:
                    fields: dict[str, Any] = {
                        'videoGeneration.provider': 'ark',
                        'videoGeneration.providerTaskId': provider_task_id,
                        'videoGeneration.status': provider_status,
                        'videoGeneration.updatedAt': datetime.now(timezone.utc),
                    }
                    if extra_fields:
                        fields.update(extra_fields)
                    db.clips.update_one({'clipId': clip['clipId']}, {'$set': fields})

                def on_ark_submitted(provider_task_id: str) -> None:
                    provider_task_state['task_id'] = provider_task_id
                    persist_provider_state(provider_task_id, 'submitted', {'videoGeneration.lastError': None})

                def on_ark_poll(status: str, attempt: int, provider_task_id: str) -> None:
                    normalized = (status or 'running').strip() or 'running'
                    should_emit = attempt == 1 or attempt - last_poll_emit['attempt'] >= 3
                    if normalized != last_poll_emit['status']:
                        should_emit = True
                    if not should_emit:
                        return
                    persist_provider_state(provider_task_id, normalized, {'videoGeneration.lastError': None})
                    publish_progress(
                        task_id,
                        pct,
                        f'生成视频 {i + 1}/{len(jobs)}: 供应商处理中（{normalized}，轮询 {attempt}，任务 {provider_task_id}）',
                        'generating_video',
                    )
                    last_poll_emit['attempt'] = attempt
                    last_poll_emit['status'] = normalized

                video_url, provider_task_id = _request_ark_video(
                    base_url=base_url,
                    api_key=api_key,
                    model=model,
                    content=content,
                    aspect_ratio=video_ratio,
                    resolution=resolution,
                    generate_audio=generate_audio,
                    duration=duration,
                    resume_task_id=resume_provider_task_id or None,
                    on_submitted=on_ark_submitted,
                    on_poll=on_ark_poll,
                )
            except Exception as exc:
                if provider_task_state['task_id']:
                    db.clips.update_one(
                        {'clipId': clip['clipId']},
                        {'$set': {
                            'videoGeneration.provider': 'ark',
                            'videoGeneration.providerTaskId': provider_task_state['task_id'],
                            'videoGeneration.status': 'failed',
                            'videoGeneration.lastError': str(exc),
                            'videoGeneration.updatedAt': datetime.now(timezone.utc),
                        }},
                    )
                run_errors.append(f'情节 {clip.get("clipIndex", 0) + 1}: {exc}')
                continue

            publish_progress(
                task_id,
                pct,
                f'转存视频到 OSS {i + 1}/{len(jobs)}: {clip.get("summary", "")[:24]}...',
                'uploading_video',
            )
            uploading_at = datetime.now(timezone.utc)
            db.clips.update_one(
                {'clipId': clip['clipId']},
                {'$set': {
                    'videoGeneration.provider': 'ark',
                    'videoGeneration.providerTaskId': provider_task_id,
                    'videoGeneration.status': 'uploading',
                    'videoGeneration.lastError': None,
                    'videoGeneration.updatedAt': uploading_at,
                    'updatedAt': uploading_at,
                }},
            )
            try:
                persisted_video = _persist_video_to_oss(clip, video_url)
            except Exception as exc:
                db.clips.update_one(
                    {'clipId': clip['clipId']},
                    {'$set': {
                        'videoGeneration.provider': 'ark',
                        'videoGeneration.providerTaskId': provider_task_id,
                        'videoGeneration.status': 'failed',
                        'videoGeneration.lastError': f'视频转存 OSS 失败: {exc}',
                        'videoGeneration.updatedAt': datetime.now(timezone.utc),
                    }},
                )
                run_errors.append(f'情节 {clip.get("clipIndex", 0) + 1}: 视频转存 OSS 失败 - {exc}')
                continue

            completed_at = datetime.now(timezone.utc)
            db.clips.update_one(
                {'clipId': clip['clipId']},
                {'$set': {
                    'videoUrl': persisted_video['url'],
                    'videoGeneration.provider': 'ark',
                    'videoGeneration.providerTaskId': provider_task_id,
                    'videoGeneration.status': 'completed',
                    'videoGeneration.lastError': None,
                    'videoGeneration.ossObjectKey': persisted_video['objectKey'],
                    'videoGeneration.completedAt': completed_at,
                    'videoGeneration.updatedAt': completed_at,
                    'updatedAt': completed_at,
                }},
            )
            try:
                continuity_update = _propagate_continuity_frame(db, clip, persisted_video['url'], completed_at)
                if continuity_update:
                    continuity_updates.append(continuity_update)
            except Exception as continuity_exc:
                continuity_errors.append(
                    f'情节 {clip.get("clipIndex", 0) + 1} 连续性抽帧失败: {continuity_exc}'
                )
            success += 1

        if success == 0:
            raise ValueError('视频生成全部失败：' + ' | '.join(run_errors[:8]))

        if len(run_errors) == 0:
            db.episodes.update_one(
                {'episodeId': episode_id},
                {'$set': {'status': 'video_ready', 'updatedAt': now}},
            )

        result_data = {
            'successCount': success,
            'failedCount': len(run_errors),
            'total': len(jobs) + len(build_errors),
            'errors': run_errors,
            'continuityUpdates': continuity_updates,
            'continuityErrors': continuity_errors,
        }
        publish_complete(task_id, result_data)
        return result_data

    except Exception as exc:
        err_msg = str(exc)
        if self.request.retries < self.max_retries:
            set_task_state(task_id, status='retrying', message=f'任务重试中: {err_msg}')
            raise self.retry(exc=exc)

        publish_error(task_id, err_msg)
        raise exc
