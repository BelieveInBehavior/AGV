"""
Celery Task: 分镜 / 情节首尾帧 生成

冷热分离:
  热 (Redis): 进度广播
  冷 (MongoDB): clips → panels（经典多分镜）或 storyboardPlan（首尾关键帧）
"""

from datetime import datetime, timezone
from uuid import uuid4

from celery_app import app
from skills.generate_storyboard import generate_storyboard_skill
from tasks.beat_prompt_task import apply_beat_frame_plan_for_clip
from utils.ai_settings import get_ai_settings_for_project
from utils.db import get_db
from utils.redis_client import publish_progress, publish_complete, publish_error, set_task_state


def _use_multi_panel(clip: dict, storyboard_mode: str) -> bool:
    if storyboard_mode == 'panels':
        return True
    if storyboard_mode == 'beat_frames':
        return False
    # auto
    return clip.get('sceneComplexity') == 'complex'


@app.task(
    name='tasks.storyboard_task.generate_storyboard',
    bind=True,
    max_retries=2,
    default_retry_delay=15,
    queue='storyboard',
)
def generate_storyboard(
    self,
    task_id: str,
    episode_id: str,
    project_id: str,
    clip_ids: list = None,
    storyboard_mode: str = 'auto',
    **kwargs,
):
    db = get_db()
    now = datetime.now(timezone.utc)

    try:
        mode = (storyboard_mode or 'auto').lower()
        if mode not in ('auto', 'beat_frames', 'panels'):
            mode = 'auto'

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
            raise ValueError('No clips found for storyboard generation')

        total_panels = 0
        beat_clip_count = 0
        panel_clip_count = 0

        for i, clip in enumerate(clips):
            pct = 5 + int((i + 1) / len(clips) * 88)
            use_panels = _use_multi_panel(clip, mode)

            if use_panels:
                publish_progress(
                    task_id, pct,
                    f"多分镜 {i + 1}/{len(clips)}: {clip.get('summary', '')[:30]}...",
                    'generating_panels',
                )
                panels = generate_storyboard_skill(
                    clip=clip,
                    characters=characters,
                    locations=locations,
                    art_style=art_style,
                    language=language,
                    ai_settings=ai_settings,
                )

                db.panels.delete_many({'clipId': clip['clipId']})

                panel_docs = []
                for j, panel in enumerate(panels):
                    panel_id = f"panel_{uuid4().hex[:12]}"
                    panel_docs.append({
                        'panelId': panel_id,
                        'clipId': clip['clipId'],
                        'episodeId': episode_id,
                        'projectId': project_id,
                        'panelIndex': panel.get('panelIndex', j),
                        'description': panel.get('description', ''),
                        'characters': panel.get('characters', []),
                        'location': panel.get('location', clip.get('location', '')),
                        'shotType': panel.get('shotType', 'medium shot'),
                        'cameraMovement': panel.get('cameraMovement', 'static'),
                        'mood': panel.get('mood', clip.get('mood', '')),
                        'action': panel.get('action', ''),
                        'dialogue': panel.get('dialogue', ''),
                        'imagePrompt': panel.get('imagePrompt', panel.get('description', '')),
                        'videoPrompt': panel.get('videoPrompt', ''),
                        'imageUrl': None,
                        'videoUrl': None,
                        'status': 'draft',
                        'createdAt': now,
                        'updatedAt': now,
                    })

                if panel_docs:
                    db.panels.insert_many(panel_docs)
                    db.clips.update_one(
                        {'clipId': clip['clipId']},
                        {'$set': {
                            'panelIds': [p['panelId'] for p in panel_docs],
                            'storyboardPlan': None,
                            'updatedAt': now,
                        }},
                    )
                    total_panels += len(panel_docs)
                else:
                    db.clips.update_one(
                        {'clipId': clip['clipId']},
                        {'$set': {'panelIds': [], 'storyboardPlan': None, 'updatedAt': now}},
                    )
                panel_clip_count += 1
            else:
                publish_progress(
                    task_id, pct,
                    f"首尾帧 {i + 1}/{len(clips)}: {clip.get('summary', '')[:30]}...",
                    'generating_beat_frames',
                )
                apply_beat_frame_plan_for_clip(
                    db, now, episode_id, project_id, clip,
                    characters=characters,
                    locations=locations,
                    art_style=art_style,
                    language=language,
                    ai_settings=ai_settings,
                )
                beat_clip_count += 1

        ep_status = 'storyboard_ready' if panel_clip_count > 0 else 'beat_prompts_ready'
        db.episodes.update_one(
            {'episodeId': episode_id},
            {'$set': {'status': ep_status, 'updatedAt': now}},
        )

        result_data = {
            'panelCount': total_panels,
            'clipCount': len(clips),
            'beatClipCount': beat_clip_count,
            'multiPanelClipCount': panel_clip_count,
            'storyboardMode': mode,
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
