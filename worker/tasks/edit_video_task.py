"""
Celery Task: 视频后处理 / 剪辑

流程:
  1. 按 clipIndex 顺序读取各 clip 的 videoUrl
  2. 选择剪辑策略（单独剪辑 / 全集拼接）
  3. 调用 ffmpeg 进行转存、去人声、帧提取等后处理
  4. 如有需要，生成 SRT 字幕文件并上传到 OSS
  5. 上传处理后的视频到 OSS
  6. 写回 clip.editedVideoUrl 或创建剧集级 compiledVideoUrl
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from typing import Any

import httpx

from celery_app import app
from utils.db import get_db
from utils.redis_client import publish_complete, publish_error, publish_progress, set_task_state
from utils.reference_assets import sign_oss_url, upload_file_to_oss, _upload_bytes_to_oss


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


def _download_to_temp_file(url: str, suffix: str) -> tuple[str, str]:
    fd, temp_path = tempfile.mkstemp(prefix='agv_edit_', suffix=suffix)
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


def _remove_vocals(input_path: str, output_path: str, strength: str = 'soft') -> None:
    """使用 ffmpeg 进行去人声处理（中置抵消法则）"""
    ffmpeg_bin = _ffmpeg_binary()
    if not ffmpeg_bin:
        raise RuntimeError('ffmpeg 不可用，无法进行去人声处理')

    af = ''
    if strength == 'soft':
        af = 'stereotools=mlev=0.2:slev=1,volume=1.6'
    elif strength == 'hard':
        af = 'pan=stereo|c0=FL-FR|c1=FR-FL,volume=1.8'
    else:
        raise ValueError(f'Unknown strength: {strength}')

    cmd = [
        ffmpeg_bin, '-y', '-i', input_path,
        '-af', af,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        output_path,
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=180)
    if proc.returncode != 0 or not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
        detail = (proc.stderr or proc.stdout or '').strip()[-500:]
        raise RuntimeError(f'ffmpeg 去人声失败: {detail or "unknown error"}')


def _transcode_video(input_path: str, output_path: str, crf: int = 23, preset: str = 'fast') -> None:
    """通用视频转码：H.264 + AAC"""
    ffmpeg_bin = _ffmpeg_binary()
    if not ffmpeg_bin:
        raise RuntimeError('ffmpeg 不可用')

    cmd = [
        ffmpeg_bin, '-y', '-i', input_path,
        '-c:v', 'libx264', '-crf', str(crf), '-preset', preset,
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        output_path,
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=300)
    if proc.returncode != 0 or not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
        detail = (proc.stderr or proc.stdout or '').strip()[-500:]
        raise RuntimeError(f'ffmpeg 转码失败: {detail or "unknown error"}')


def _merge_clips(
    input_paths: list[str],
    output_path: str,
    transition_duration: float = 0.5,
) -> None:
    """
    将多个视频片段拼接，使用淡入淡出过渡和连接处锐化

    Args:
        input_paths: 输入视频路径列表（按顺序）
        output_path: 输出路径
        transition_duration: 过渡持续时间（秒）
    """
    ffmpeg_bin = _ffmpeg_binary()
    if not ffmpeg_bin:
        raise RuntimeError('ffmpeg 不可用，无法进行视频拼接')

    if len(input_paths) == 0:
        raise ValueError('No input files')
    if len(input_paths) == 1:
        _transcode_video(input_paths[0], output_path)
        return

    # 多个文件：逐对过渡拼接
    current = input_paths[0]
    for i in range(1, len(input_paths)):
        next_file = input_paths[i]
        merged_fd, merged_path = tempfile.mkstemp(prefix='agv_merged_', suffix='.mp4')
        os.close(merged_fd)

        try:
            # 计算第一个文件的时长
            probe_cmd = [
                'ffprobe', '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=nw=1:nk=1',
                current,
            ]
            dur_result = subprocess.run(probe_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
            dur_a = float(dur_result.stdout.strip())
            offset = max(dur_a - transition_duration, 0.0)

            # 拼接：淡入淡出 + 连接处锐化
            filter_graph = (
                f"[0:v]format=yuv420p,settb=1/60000,setpts=PTS-STARTPTS[v0];"
                f"[1:v]format=yuv420p,settb=1/60000,setpts=PTS-STARTPTS[v1];"
                f"[v0][v1]xfade=transition=fade:duration={transition_duration}:offset={offset}[vx];"
                f"[vx]unsharp=5:5:1.2:5:5:0.0:enable='between(t,{offset}-0.1,{offset}+{transition_duration}+0.1)'[vout];"
                f"[0:a]aresample=44100,asetpts=PTS-STARTPTS[a0];"
                f"[1:a]aresample=44100,asetpts=PTS-STARTPTS[a1];"
                f"[a0][a1]acrossfade=d={transition_duration}:c1=tri:c2=tri[aout]"
            )
            merge_cmd = [
                ffmpeg_bin, '-y',
                '-i', current,
                '-i', next_file,
                '-filter_complex', filter_graph,
                '-map', '[vout]',
                '-map', '[aout]',
                '-c:v', 'libx264',
                '-crf', '18',
                '-preset', 'medium',
                '-r', '24',
                '-pix_fmt', 'yuv420p',
                '-c:a', 'aac',
                '-b:a', '192k',
                merged_path,
            ]
            proc = subprocess.run(merge_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=600)
            if proc.returncode != 0 or not os.path.exists(merged_path) or os.path.getsize(merged_path) == 0:
                detail = (proc.stderr or proc.stdout or '').strip()[-500:]
                raise RuntimeError(f'ffmpeg 拼接失败: {detail or "unknown error"}')

            # 清理前一个临时文件
            if current != input_paths[0]:
                try:
                    os.unlink(current)
                except OSError:
                    pass
            current = merged_path
        except Exception:
            try:
                os.unlink(merged_path)
            except OSError:
                pass
            raise

    # 最后的结果移到输出路径
    if current != input_paths[0]:
        shutil.move(current, output_path)
    else:
        shutil.copy(current, output_path)


def _persist_video_to_oss(
    episode_id: str,
    source: str,
    file_name: str = 'edited_episode.mp4',
) -> dict[str, str]:
    """下载、转码并上传视频到 OSS。source 可以是 http URL 或本地文件路径。"""
    safe_url = _clean_http_url(source)

    if safe_url:
        temp_path, content_type = _download_to_temp_file(safe_url, '.mp4')
    elif isinstance(source, str) and os.path.isfile(source):
        temp_path = source
        content_type = 'video/mp4'
    else:
        raise ValueError('视频 URL 无效')

    try:
        # 可选：转码为 480p（节省存储空间）
        transcoded_path = _transcode_to_480p(temp_path) if _ffmpeg_binary() else None
        upload_path = transcoded_path or temp_path

        uploaded = upload_file_to_oss(
            upload_path,
            file_name=file_name,
            sub_dir=f'videos/episodes/{episode_id}',
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
        if safe_url:
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


def _transcode_to_480p(input_path: str) -> str | None:
    """转码为 480P（高度 480，宽度按原始比例缩放）"""
    ffmpeg_bin = _ffmpeg_binary()
    if not ffmpeg_bin:
        return None

    out_fd, out_path = tempfile.mkstemp(prefix='agv_480p_', suffix='.mp4')
    os.close(out_fd)
    cmd = [
        ffmpeg_bin, '-y', '-i', input_path,
        '-vf', 'scale=-2:480',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        out_path,
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=180)
    if proc.returncode != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        detail = (proc.stderr or proc.stdout or '').strip()[-500:]
        raise RuntimeError(f'ffmpeg 480P 转码失败: {detail or "unknown error"}')
    return out_path


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


def _clamp_subtitle_time(value: Any, fallback: float, maximum: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = fallback
    if maximum <= 0:
        return max(parsed, 0.0)
    return min(max(parsed, 0.0), maximum)


def _clean_subtitle_text(value: Any) -> str:
    if not isinstance(value, str):
        return ''
    lines = [line.strip() for line in value.replace('\r\n', '\n').split('\n')]
    compact = '\n'.join(line for line in lines if line)
    return compact.strip()


def _clamp_subtitle_percent(value: Any, fallback: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = fallback
    return min(max(parsed, 4.0), 96.0)


def _normalize_subtitle_position(vertical: Any, align: Any, x: Any = None, y: Any = None) -> dict[str, Any]:
    safe_vertical = str(vertical or 'bottom').strip().lower()
    safe_align = str(align or 'center').strip().lower()
    if safe_vertical not in ('top', 'middle', 'bottom'):
        safe_vertical = 'bottom'
    if safe_align not in ('start', 'center', 'end'):
        safe_align = 'center'
    x_map = {'start': 14.0, 'center': 50.0, 'end': 86.0}
    y_map = {'top': 14.0, 'middle': 50.0, 'bottom': 88.0}
    safe_x = _clamp_subtitle_percent(x, x_map.get(safe_align, 50.0))
    safe_y = _clamp_subtitle_percent(y, y_map.get(safe_vertical, 88.0))
    return {'vertical': safe_vertical, 'align': safe_align, 'x': safe_x, 'y': safe_y}


def _normalize_subtitle_animation(value: Any) -> str:
    safe = str(value or 'fade').strip().lower()
    return safe if safe in ('none', 'fade', 'slide-up', 'pop') else 'fade'


def _normalize_subtitle_cues(cues: Any, video_duration: float) -> list[dict[str, Any]]:
    if not isinstance(cues, list):
        return []

    normalized: list[dict[str, Any]] = []
    safe_duration = max(float(video_duration or 0), 0.2)

    for raw in cues:
        if not isinstance(raw, dict):
            continue

        text = _clean_subtitle_text(raw.get('text'))
        if not text:
            continue

        start = _clamp_subtitle_time(raw.get('start'), 0.0, safe_duration)
        end = _clamp_subtitle_time(raw.get('end'), min(start + 2.0, safe_duration), safe_duration)
        if end <= start:
            end = min(safe_duration, start + 0.8)
        if end <= start:
            continue

        position = raw.get('position') if isinstance(raw.get('position'), dict) else {}
        vertical = position.get('vertical', raw.get('vertical'))
        align = position.get('align', raw.get('align'))
        x = position.get('x', raw.get('x'))
        y = position.get('y', raw.get('y'))
        normalized.append({
            'start': round(start, 3),
            'end': round(end, 3),
            'text': text,
            'position': _normalize_subtitle_position(vertical, align, x, y),
            'animation': _normalize_subtitle_animation(raw.get('animation')),
        })

    normalized.sort(key=lambda cue: (cue['start'], cue['end']))

    compacted: list[dict[str, Any]] = []
    last_end = 0.0
    for cue in normalized:
        start = max(cue['start'], last_end)
        end = max(cue['end'], start + 0.2)
        if end > safe_duration:
            end = safe_duration
        if end <= start:
            continue
        fixed = {**cue, 'start': round(start, 3), 'end': round(end, 3)}
        compacted.append(fixed)
        last_end = fixed['end']

    return compacted


def _format_vtt_time(seconds: float) -> str:
    safe = max(float(seconds or 0), 0.0)
    hours = int(safe // 3600)
    minutes = int((safe % 3600) // 60)
    secs = int(safe % 60)
    millis = int(round((safe - int(safe)) * 1000))
    if millis >= 1000:
        secs += 1
        millis -= 1000
    return f'{hours:02d}:{minutes:02d}:{secs:02d}.{millis:03d}'


def _subtitle_position_to_vtt_settings(position: dict[str, str]) -> str:
    x = _clamp_subtitle_percent(position.get('x'), 50.0)
    y = _clamp_subtitle_percent(position.get('y'), 88.0)
    return f"line:{y:.1f}% position:{x:.1f}% align:center size:72%"


def _create_subtitle_vtt(
    subtitle_text: str | None = None,
    *,
    cues: list[dict[str, Any]] | None = None,
    video_duration: float = 10,
    position: str = 'bottom',
) -> str:
    fd, vtt_path = tempfile.mkstemp(prefix='agv_sub_', suffix='.vtt')
    try:
        normalized_cues = _normalize_subtitle_cues(cues or [], video_duration)
        if not normalized_cues:
            cleaned_text = _clean_subtitle_text(subtitle_text or '')
            if cleaned_text:
                safe_position = _normalize_subtitle_position(position, 'center')
                end_sec = max(video_duration - 0.25, 1.5)
                normalized_cues = [{
                    'start': 0.0,
                    'end': round(end_sec, 3),
                    'text': cleaned_text,
                    'position': safe_position,
                    'animation': 'fade',
                }]

        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write('WEBVTT\n\n')
            for idx, cue in enumerate(normalized_cues, start=1):
                settings = _subtitle_position_to_vtt_settings(cue['position'])
                f.write(f'{idx}\n')
                f.write(f"{_format_vtt_time(cue['start'])} --> {_format_vtt_time(cue['end'])} {settings}\n")
                f.write(cue['text'] + '\n\n')
    except Exception:
        try:
            os.unlink(vtt_path)
        except OSError:
            pass
        raise
    return vtt_path


def _upload_subtitle_to_oss(
    episode_id: str,
    subtitle_text: str | None = None,
    *,
    cues: list[dict[str, Any]] | None = None,
    file_name: str = 'subtitle.vtt',
    video_duration: float = 10,
    position: str = 'bottom',
) -> dict[str, str]:
    """将字幕内容上传到 OSS，返回可访问的 URL"""
    vtt_path = _create_subtitle_vtt(
        subtitle_text,
        cues=cues,
        video_duration=video_duration,
        position=position,
    )
    try:
        uploaded = upload_file_to_oss(
            vtt_path,
            file_name=file_name,
            sub_dir=f'videos/episodes/{episode_id}',
            content_type='text/vtt',
        )
        final_url = _clean_http_url(uploaded.get('url'))
        object_key = str(uploaded.get('objectKey') or '').strip()
        return {'url': final_url, 'objectKey': object_key}
    finally:
        try:
            os.unlink(vtt_path)
        except OSError:
            pass


def _resolve_subtitle_payload_for_clip(clip: dict, edit_opts: dict, video_duration: float) -> dict[str, Any]:
    """根据 editOptions 解析单个 clip 的字幕内容（文本或时间轴）"""
    subtitle_opts = edit_opts.get('subtitles') or {}
    if isinstance(subtitle_opts, str):
        subtitle_opts = {'mode': subtitle_opts}

    mode = str(subtitle_opts.get('mode', 'none')).strip()
    if mode == 'none':
        return {'text': '', 'cues': [], 'position': 'bottom'}

    if mode == 'timeline':
        timeline_by_clip = subtitle_opts.get('timelineByClip') if isinstance(subtitle_opts.get('timelineByClip'), dict) else {}
        clip_id = str(clip.get('clipId') or '').strip()
        raw_cues = timeline_by_clip.get(clip_id)
        return {
            'text': '',
            'cues': _normalize_subtitle_cues(raw_cues, video_duration),
            'position': 'bottom',
        }

    if mode == 'custom':
        text = str(subtitle_opts.get('text', '')).strip()
    else:  # auto
        text = clip.get('dialogue', '').strip() or clip.get('summary', '').strip()

    text = _clean_subtitle_text(text)
    position = str(subtitle_opts.get('position', 'bottom')).strip().lower()
    if position not in ('top', 'middle', 'bottom'):
        position = 'bottom'
    return {'text': text, 'cues': [], 'position': position}


def _resolve_subtitle_payload_for_compile(
    editable_clips: list,
    edit_opts: dict,
    clip_durations: dict[str, float] | None = None,
) -> dict[str, Any]:
    """解析全集拼接时的字幕文本 / cues"""
    subtitle_opts = edit_opts.get('subtitles') or {}
    if isinstance(subtitle_opts, str):
        subtitle_opts = {'mode': subtitle_opts}

    mode = str(subtitle_opts.get('mode', 'none')).strip()
    if mode == 'none':
        return {'text': '', 'cues': [], 'position': 'bottom'}

    if mode == 'timeline':
        raise ValueError('时间轴字幕当前仅支持「单独编辑各情节」模式')

    if mode == 'custom':
        text = str(subtitle_opts.get('text', '')).strip()
        return {
            'text': _clean_subtitle_text(text),
            'cues': [],
            'position': str(subtitle_opts.get('position', 'bottom')).strip().lower() or 'bottom',
        }

    cues: list[dict[str, Any]] = []
    cursor = 0.0
    for clip in editable_clips:
        clip_id = str(clip.get('clipId') or '').strip()
        duration = max(float((clip_durations or {}).get(clip_id) or clip.get('duration') or 0), 0.8)
        text = _clean_subtitle_text(clip.get('dialogue', '').strip() or clip.get('summary', '').strip())
        if text:
            cues.append({
                'start': round(cursor, 3),
                'end': round(cursor + duration, 3),
                'text': text,
                'position': _normalize_subtitle_position(subtitle_opts.get('position', 'bottom'), 'center'),
                'animation': 'fade',
            })
        cursor += duration

    return {'text': '', 'cues': _normalize_subtitle_cues(cues, cursor or 10), 'position': 'bottom'}


def _build_subtitle_name(file_name: str) -> str:
    """生成字幕文件名称（与视频文件同名，后缀 .vtt）"""
    base = re.sub(r'\.[^.]+$', '', file_name)
    return f'{base}.vtt'


@app.task(
    name='tasks.edit_video_task.edit_videos',
    bind=True,
    max_retries=1,
    default_retry_delay=30,
    queue='video',
)
def edit_videos(
    self,
    task_id: str,
    project_id: str,
    episode_id: str | None = None,
    clip_ids: list | None = None,
    edit_options: dict | None = None,
    **kwargs,
):
    """
    视频编辑任务：后处理、拼接、去人声、字幕等

    支持的 edit_options:
      - strategy: 'individual' | 'compile'（单独编辑 / 全集拼接，默认 individual）
      - removeVocals: true | false | 'soft' | 'hard'（是否去人声）
      - transitionDuration: 0.5（拼接过渡时长，秒）
      - subtitles: {mode: 'none' | 'auto' | 'custom'; text?: string}
    """
    db = get_db()
    now = datetime.now(timezone.utc)

    try:
        if not episode_id:
            raise ValueError('episodeId required for video editing')

        set_task_state(task_id, status='running', progress=5, message='准备视频编辑...')

        edit_opts = edit_options or {}
        strategy = str(edit_opts.get('strategy', 'individual')).strip() or 'individual'
        remove_vocals = edit_opts.get('removeVocals', False)
        transition_duration = float(edit_opts.get('transitionDuration', 0.5))

        if strategy not in ('individual', 'compile'):
            raise ValueError(f'Invalid strategy: {strategy}')

        # 查询该集所有 clips
        query = {'episodeId': episode_id, 'isActive': {'$ne': False}}
        if clip_ids:
            query['clipId'] = {'$in': clip_ids}
        clips = list(db.clips.find(query).sort('clipIndex', 1))

        if not clips:
            raise ValueError('No clips found for editing')

        # 过滤已有 videoUrl 的 clips
        editable_clips = [c for c in clips if c.get('videoUrl')]
        if not editable_clips:
            raise ValueError('No clips with videoUrl available for editing')

        success = 0
        errors = []
        subtitle_results: list[dict[str, str]] = []

        if strategy == 'individual':
            # 单独编辑每个 clip
            for i, clip in enumerate(editable_clips):
                pct = 5 + int((i + 1) / len(editable_clips) * 90)
                publish_progress(
                    task_id,
                    pct,
                    f'编辑视频 {i + 1}/{len(editable_clips)}: {clip.get("summary", "")[:24]}...',
                    'editing_individual',
                )
                try:
                    clip_id = clip.get('clipId')
                    video_url = _clean_http_url(sign_oss_url(clip.get('videoUrl')) or clip.get('videoUrl'))
                    if not video_url:
                        errors.append(f'情节 {clip.get("clipIndex", 0) + 1} 视频 URL 无效')
                        continue

                    # 下载视频
                    input_path, _ = _download_to_temp_file(video_url, '.mp4')
                    out_fd, output_path = tempfile.mkstemp(prefix='agv_edited_', suffix='.mp4')
                    os.close(out_fd)

                    try:
                        # 去人声处理
                        if remove_vocals:
                            vocal_strength = remove_vocals if isinstance(remove_vocals, str) else 'soft'
                            vocal_fd, vocal_path = tempfile.mkstemp(prefix='agv_vocal_', suffix='.mp4')
                            os.close(vocal_fd)
                            try:
                                _remove_vocals(input_path, vocal_path, vocal_strength)
                                _transcode_video(vocal_path, output_path)
                            finally:
                                if vocal_path != input_path:
                                    try:
                                        os.unlink(vocal_path)
                                    except OSError:
                                        pass
                        else:
                            _transcode_video(input_path, output_path)

                        # 上传到 OSS
                        persisted = _persist_video_to_oss(
                            episode_id,
                            output_path,
                            f'{clip_id}_edited.mp4',
                        )

                        video_duration = _get_video_duration(output_path)
                        subtitle_payload = _resolve_subtitle_payload_for_clip(clip, edit_opts, video_duration)
                        if subtitle_payload['text'] or subtitle_payload['cues']:
                            try:
                                sub_persisted = _upload_subtitle_to_oss(
                                    episode_id,
                                    subtitle_payload['text'],
                                    cues=subtitle_payload['cues'],
                                    file_name=_build_subtitle_name(f'{clip_id}_edited.mp4'),
                                    video_duration=video_duration,
                                    position=subtitle_payload['position'],
                                )
                                subtitle_results.append({
                                    'clipId': clip_id,
                                    'url': sub_persisted['url'],
                                    'objectKey': sub_persisted['objectKey'],
                                })
                            except Exception as se:
                                # 字幕失败不影响主流程
                                pass

                        # 写回数据库
                        update_data = {
                            'editedVideoUrl': persisted['url'],
                            'updatedAt': now,
                        }
                        if subtitle_results and subtitle_results[-1].get('clipId') == clip_id:
                            update_data['subtitleUrl'] = subtitle_results[-1]['url']

                        db.clips.update_one(
                            {'clipId': clip_id},
                            {'$set': update_data},
                        )
                        success += 1
                    finally:
                        for path in (input_path, output_path):
                            try:
                                os.unlink(path)
                            except OSError:
                                pass
                except Exception as e:
                    errors.append(f'情节 {clip.get("clipIndex", 0) + 1} 编辑失败: {e}')

        else:  # strategy == 'compile'
            # 全集拼接：下载所有 clips → 拼接 → 去人声（可选）→ 上传
            publish_progress(
                task_id,
                10,
                f'下载 {len(editable_clips)} 个视频片段...',
                'downloading_clips',
            )
            clip_paths = []
            try:
                clip_durations: dict[str, float] = {}
                for clip in editable_clips:
                    video_url = _clean_http_url(sign_oss_url(clip.get('videoUrl')) or clip.get('videoUrl'))
                    if not video_url:
                        errors.append(f'情节 {clip.get("clipIndex", 0) + 1} 视频 URL 无效')
                        continue
                    path, _ = _download_to_temp_file(video_url, '.mp4')
                    clip_paths.append(path)
                    clip_durations[str(clip.get('clipId') or '')] = _get_video_duration(path)

                if not clip_paths:
                    raise ValueError('No valid clips downloaded')

                publish_progress(
                    task_id,
                    30,
                    f'拼接 {len(clip_paths)} 个视频片段...',
                    'merging_clips',
                )

                merged_fd, merged_path = tempfile.mkstemp(prefix='agv_compiled_', suffix='.mp4')
                os.close(merged_fd)
                upload_source = merged_path
                try:
                    _merge_clips(clip_paths, merged_path, transition_duration)

                    publish_progress(
                        task_id,
                        60,
                        '处理音频...',
                        'processing_audio',
                    )

                    if remove_vocals:
                        vocal_strength = remove_vocals if isinstance(remove_vocals, str) else 'soft'
                        final_fd, final_path = tempfile.mkstemp(prefix='agv_final_', suffix='.mp4')
                        os.close(final_fd)
                        _remove_vocals(merged_path, final_path, vocal_strength)
                        upload_source = final_path
                    else:
                        upload_source = merged_path

                    # 处理字幕
                    compiled_duration = _get_video_duration(upload_source)
                    subtitle_payload = _resolve_subtitle_payload_for_compile(editable_clips, edit_opts, clip_durations)
                    if subtitle_payload['text'] or subtitle_payload['cues']:
                        publish_progress(
                            task_id,
                            70,
                            '生成字幕文件...',
                            'processing_subtitles',
                        )
                        try:
                            sub_persisted = _upload_subtitle_to_oss(
                                episode_id,
                                subtitle_payload['text'],
                                cues=subtitle_payload['cues'],
                                file_name=_build_subtitle_name('compiled_episode.mp4'),
                                video_duration=compiled_duration,
                                position=subtitle_payload['position'],
                            )
                            subtitle_results.append({
                                'clipId': None,
                                'url': sub_persisted['url'],
                                'objectKey': sub_persisted['objectKey'],
                            })
                        except Exception as se:
                            pass  # 字幕失败不影响主流程

                    publish_progress(
                        task_id,
                        75,
                        '上传完整视频到 OSS...',
                        'uploading',
                    )
                    persisted = _persist_video_to_oss(
                        episode_id,
                        upload_source,
                        'compiled_episode.mp4',
                    )

                    # 写回每个 clip 的 editedVideoUrl（完整集）
                    clip_update_data: dict[str, Any] = {
                        'editedVideoUrl': persisted['url'],
                        'updatedAt': now,
                    }
                    if subtitle_results:
                        clip_update_data['subtitleUrl'] = subtitle_results[0]['url']

                    db.clips.update_many(
                        {'episodeId': episode_id, 'isActive': {'$ne': False}},
                        {'$set': clip_update_data},
                    )

                    # 更新 episode 状态
                    episode_update_data: dict[str, Any] = {
                        'compiledVideoUrl': persisted['url'],
                        'status': 'edited',
                        'updatedAt': now,
                    }
                    if subtitle_results:
                        episode_update_data['subtitleUrl'] = subtitle_results[0]['url']

                    db.episodes.update_one(
                        {'episodeId': episode_id},
                        {'$set': episode_update_data},
                    )
                    success = len(editable_clips)
                finally:
                    # 清理临时文件
                    if upload_source and upload_source != merged_path:
                        try:
                            os.unlink(upload_source)
                        except OSError:
                            pass
                    try:
                        os.unlink(merged_path)
                    except OSError:
                        pass
            finally:
                for path in clip_paths:
                    try:
                        os.unlink(path)
                    except OSError:
                        pass

        if success == 0 and errors:
            raise ValueError('视频编辑全部失败：' + ' | '.join(errors[:5]))

        result_data = {
            'strategy': strategy,
            'successCount': success,
            'failedCount': len(errors),
            'errors': errors,
            'subtitleResults': subtitle_results,
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
