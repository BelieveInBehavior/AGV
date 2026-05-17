"""
Celery Task: 批量生成角色/场景参考图

故事分析完成后自动触发：
  - 遍历 project.characters / locations
  - 有 imagePrompt 但没有 referenceImageUrl 的 → 调用 FAL txt2img 生成参考图
  - 写回 MongoDB project.characters[].referenceImageUrl

冷热分离:
  热 (Redis): 进度广播
  冷 (MongoDB): project.characters / locations
"""

import os
import urllib.parse
from datetime import datetime, timezone

from celery_app import app
from utils.ai_settings import get_ai_settings_for_project
from utils.db import get_db
from utils.redis_client import publish_progress, publish_complete, publish_error, set_task_state
import config


def _txt2img_fal(prompt: str, width: int, height: int, fal_key: str, model_id: str) -> str | None:
    """纯文生图，用于角色/场景参考图首次生成。"""
    import fal_client

    prev = os.environ.get('FAL_KEY')
    os.environ['FAL_KEY'] = fal_key
    try:
        result = fal_client.subscribe(
            model_id,
            arguments={
                'prompt': prompt,
                'negative_prompt': 'blurry, low quality, deformed, watermark, multiple characters, crowd',
                'image_size': {'width': width, 'height': height},
                'num_inference_steps': 4,
                'num_images': 1,
            },
        )
    finally:
        if prev is None:
            os.environ.pop('FAL_KEY', None)
        else:
            os.environ['FAL_KEY'] = prev

    images = result.get('images', [])
    return images[0]['url'] if images else None


def _get_resolution(video_ratio: str) -> tuple[int, int]:
    ratios = {
        '16:9': (1280, 720),
        '9:16': (720, 1280),
        '1:1': (1024, 1024),
        '4:3': (1024, 768),
        '3:4': (768, 1024),
    }
    return ratios.get(video_ratio, (1280, 720))


@app.task(
    name='tasks.reference_image_task.generate_reference_images',
    bind=True,
    max_retries=1,
    default_retry_delay=5,
    queue='image',
)
def generate_reference_images(self, task_id: str, project_id: str, **kwargs):
    """
    批量为没有 referenceImageUrl 的角色/场景生成参考图。
    仅处理已有 imagePrompt 的条目（故事分析生成或用户手动填写）。
    """
    db = get_db()
    now = datetime.now(timezone.utc)

    try:
        set_task_state(task_id, status='running', progress=5, message='准备生成参考图...')

        project = db.projects.find_one({'projectId': project_id})
        if not project:
            raise ValueError(f'Project {project_id} not found')

        ai_settings = get_ai_settings_for_project(db, project_id)
        img_cfg = ai_settings['image']
        fal_key = (img_cfg.get('apiKey') or config.FAL_API_KEY or '').strip()
        model_id = (
            (project.get('imageModel') or '').strip()
            or (img_cfg.get('model') or '').strip()
            or config.FAL_IMAGE_MODEL
            or 'fal-ai/flux/schnell'
        )
        use_fal = img_cfg.get('provider') == 'fal' and bool(fal_key)

        if not use_fal:
            publish_complete(task_id, {'skipped': True, 'reason': 'FAL not configured'})
            return {'skipped': True}

        art_style = project.get('artStyle', 'cinematic')
        video_ratio = project.get('videoRatio', '16:9')
        width, height = _get_resolution(video_ratio)
        style_bit = f'Art direction: {art_style}.'

        characters = project.get('characters', [])
        locations = project.get('locations', [])

        # 只处理有 imagePrompt 但没有 referenceImageUrl 的条目
        char_jobs = [
            c for c in characters
            if c.get('imagePrompt') and not (c.get('referenceImageUrl') or '').strip()
        ]
        loc_jobs = [
            l for l in locations
            if l.get('imagePrompt') and not (l.get('referenceImageUrl') or '').strip()
        ]

        total = len(char_jobs) + len(loc_jobs)
        if total == 0:
            publish_complete(task_id, {'generated': 0, 'reason': 'all references already exist'})
            return {'generated': 0}

        publish_progress(task_id, 10, f'将生成 {total} 张参考图（{len(char_jobs)} 角色 / {len(loc_jobs)} 场景）...', 'generating')

        done = 0

        # ── 角色参考图 ────────────────────────────────────────────────
        updated_chars = list(characters)
        for c in char_jobs:
            prompt = f'{style_bit} Character reference sheet, full body neutral pose, clear face, simple studio background. {c["imagePrompt"]}'
            try:
                url = _txt2img_fal(prompt, width, height, fal_key, model_id)
                if url:
                    for uc in updated_chars:
                        if uc.get('name') == c['name']:
                            uc['referenceImageUrl'] = url
                            break
            except Exception:
                pass  # 单张失败不阻断其他
            done += 1
            pct = 10 + int(done / total * 80)
            publish_progress(task_id, pct, f'角色参考图 {c["name"]} 完成 ({done}/{total})', 'generating')

        # ── 场景参考图 ────────────────────────────────────────────────
        updated_locs = list(locations)
        for l in loc_jobs:
            prompt = f'{style_bit} Wide environment concept art, establishing shot, no people, empty scene. {l["imagePrompt"]}'
            try:
                url = _txt2img_fal(prompt, width, height, fal_key, model_id)
                if url:
                    for ul in updated_locs:
                        if ul.get('name') == l['name']:
                            ul['referenceImageUrl'] = url
                            break
            except Exception:
                pass
            done += 1
            pct = 10 + int(done / total * 80)
            publish_progress(task_id, pct, f'场景参考图 {l["name"]} 完成 ({done}/{total})', 'generating')

        # ── 写回 MongoDB ──────────────────────────────────────────────
        db.projects.update_one(
            {'projectId': project_id},
            {'$set': {
                'characters': updated_chars,
                'locations': updated_locs,
                'updatedAt': now,
            }},
        )

        publish_complete(task_id, {'generated': done, 'total': total})
        return {'generated': done, 'total': total}

    except Exception as exc:
        err_msg = str(exc)
        if self.request.retries < self.max_retries:
            set_task_state(task_id, status='retrying', message=f'任务重试中: {err_msg}')
            raise self.retry(exc=exc)
        publish_error(task_id, err_msg)
        raise exc
