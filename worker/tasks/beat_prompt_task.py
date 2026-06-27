"""
Celery Task: 仅生成首尾帧方案（LLM → storyboardPlan，含 scene_prompt）

主流程第二步：情节分析之后、生图之前。
"""

from datetime import datetime, timezone
from celery_app import app
from skills.generate_beat_frames import generate_beat_frames_skill
from utils.ai_settings import get_ai_settings_for_project
from utils.db import get_db
from utils.redis_client import publish_progress, publish_complete, publish_error, set_task_state


def apply_beat_frame_plan_for_clip(
    db,
    now,
    episode_id: str,
    project_id: str,
    clip: dict,
    *,
    characters: list,
    locations: list,
    art_style: str,
    language: str,
    ai_settings: dict,
) -> None:
    """单条 clip 写入 storyboardPlan，清空 panels 与旧视频。"""
    plan = generate_beat_frames_skill(
        clip=clip,
        characters=characters,
        locations=locations,
        art_style=art_style,
        language=language,
        ai_settings=ai_settings,
    )
    if isinstance(plan, dict):
        plan['referenceStale'] = False
    db.panels.delete_many({'clipId': clip['clipId']})
    db.clips.update_one(
        {'clipId': clip['clipId']},
        {'$set': {
            'storyboardPlan': plan,
            'panelIds': [],
            'videoUrl': None,
            'updatedAt': now,
        }},
    )


@app.task(
    name='tasks.beat_prompt_task.generate_beat_prompts',
    bind=True,
    max_retries=2,
    default_retry_delay=15,
    queue='storyboard',
)
def generate_beat_prompts(
    self,
    task_id: str,
    episode_id: str,
    project_id: str,
    clip_ids: list | None = None,
    **kwargs,
):
    db = get_db()
    now = datetime.now(timezone.utc)

    try:
        set_task_state(task_id, status='running', progress=5, message='读取情节数据...')

        project = db.projects.find_one({'projectId': project_id})
        art_style = project.get('artStyle', 'cinematic') if project else 'cinematic'
        language = project.get('language', 'zh') if project else 'zh'
        characters = project.get('characters', []) if project else []
        locations = project.get('locations', []) if project else []

        ai_settings = get_ai_settings_for_project(db, project_id)

        query = {'episodeId': episode_id}
        if clip_ids:
            query['clipId'] = {'$in': clip_ids}
        clips = list(db.clips.find(query).sort('clipIndex', 1))

        if not clips:
            raise ValueError('No clips found for beat prompt generation')

        for i, clip in enumerate(clips):
            pct = 5 + int((i + 1) / len(clips) * 88)
            publish_progress(
                task_id, pct,
                f"首尾帧 Prompt {i + 1}/{len(clips)}: {clip.get('summary', '')[:30]}...",
                'generating_beat_prompts',
            )
            apply_beat_frame_plan_for_clip(
                db, now, episode_id, project_id, clip,
                characters=characters,
                locations=locations,
                art_style=art_style,
                language=language,
                ai_settings=ai_settings,
            )

        db.episodes.update_one(
            {'episodeId': episode_id},
            {'$set': {'status': 'beat_prompts_ready', 'updatedAt': now}},
        )

        result_data = {'clipCount': len(clips)}
        publish_complete(task_id, result_data)
        return result_data

    except Exception as exc:
        err_msg = str(exc)
        if self.request.retries < self.max_retries:
            set_task_state(task_id, status='retrying', message=f'任务重试中: {err_msg}')
            raise self.retry(exc=exc)

        publish_error(task_id, err_msg)
        raise exc
