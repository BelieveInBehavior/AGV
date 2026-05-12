"""
Celery Task: 图像生成

冷热分离:
  热 (Redis): 进度广播
  冷 (MongoDB): panels → imageUrl
"""

from datetime import datetime, timezone

from celery_app import app
from skills.build_image_prompt import build_image_prompt, get_resolution
from utils.ai_settings import get_ai_settings_for_project
from utils.db import get_db
from utils.redis_client import publish_progress, publish_complete, publish_error, set_task_state
import config


def _generate_image_fal(
    positive: str,
    negative: str,
    width: int,
    height: int,
    *,
    model_id: str,
    fal_key: str,
) -> str | None:
    """调用 FAL AI 生成图片，返回 URL（fal_client 使用环境变量 FAL_KEY）"""
    import os

    import fal_client

    prev = os.environ.get('FAL_KEY')
    os.environ['FAL_KEY'] = fal_key
    try:
        result = fal_client.subscribe(
            model_id,
            arguments={
                'prompt': positive,
                'negative_prompt': negative,
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


def _placeholder_image(description: str, width: int, height: int) -> str:
    """无 FAL key 时返回占位图"""
    import urllib.parse
    text = urllib.parse.quote(description[:30] or 'Panel')
    return f'https://placehold.co/{width}x{height}/1a1f35/ffffff?text={text}'


@app.task(
    name='tasks.image_task.generate_images',
    bind=True,
    max_retries=1,
    default_retry_delay=5,
    queue='image',
)
def generate_images(self, task_id: str, project_id: str,
                    episode_id: str = None, panel_ids: list = None,
                    panel_id: str = None, **kwargs):
    db = get_db()
    now = datetime.now(timezone.utc)

    try:
        set_task_state(task_id, status='running', progress=5, message='准备图像生成...')

        project = db.projects.find_one({'projectId': project_id})
        art_style = project.get('artStyle', 'cinematic') if project else 'cinematic'
        video_ratio = project.get('videoRatio', '16:9') if project else '16:9'
        width, height = get_resolution(video_ratio)

        ai_settings = get_ai_settings_for_project(db, project_id)
        img_cfg = ai_settings['image']
        fal_key = (img_cfg.get('apiKey') or config.FAL_API_KEY or '').strip()
        model_id = (
            (project.get('imageModel') or '').strip()
            or (img_cfg.get('model') or '').strip()
            or config.FAL_IMAGE_MODEL
        )
        use_fal = img_cfg.get('provider') == 'fal' and bool(fal_key)

        # 确定目标 panels
        if panel_id:
            panels = list(db.panels.find({'panelId': panel_id}))
        elif panel_ids:
            panels = list(db.panels.find({'panelId': {'$in': panel_ids}}))
        elif episode_id:
            panels = list(db.panels.find({'episodeId': episode_id, 'imageUrl': None}))
        else:
            raise ValueError('No panels specified')

        if not panels:
            raise ValueError('No panels found')

        success = 0

        for i, panel in enumerate(panels):
            pct = 5 + int((i + 1) / len(panels) * 90)
            publish_progress(task_id, pct, f'生成第 {i + 1}/{len(panels)} 张图片...', 'generating')

            db.panels.update_one(
                {'panelId': panel['panelId']},
                {'$set': {'status': 'generating_image', 'updatedAt': now}},
            )

            try:
                positive, negative = build_image_prompt(panel, art_style, video_ratio)

                if use_fal:
                    image_url = _generate_image_fal(
                        positive, negative, width, height,
                        model_id=model_id,
                        fal_key=fal_key,
                    )
                else:
                    image_url = _placeholder_image(panel.get('description', ''), width, height)

                db.panels.update_one(
                    {'panelId': panel['panelId']},
                    {'$set': {
                        'imageUrl': image_url,
                        'imagePromptUsed': positive,
                        'status': 'image_ready',
                        'updatedAt': now,
                    }},
                )
                success += 1

            except Exception as panel_err:
                db.panels.update_one(
                    {'panelId': panel['panelId']},
                    {'$set': {'status': 'image_failed', 'imageError': str(panel_err), 'updatedAt': now}},
                )

        result_data = {'successCount': success, 'total': len(panels)}
        publish_complete(task_id, result_data)
        return result_data

    except Exception as exc:
        err_msg = str(exc)
        if self.request.retries < self.max_retries:
            set_task_state(task_id, status='retrying', message=f'任务重试中: {err_msg}')
            raise self.retry(exc=exc)

        publish_error(task_id, err_msg)
        raise exc
