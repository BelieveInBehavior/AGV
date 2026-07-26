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


def _panel_core_fields(panel: dict, clip: dict, panel_index: int) -> dict:
    return {
        'panelIndex': panel.get('panelIndex', panel_index),
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
    }


def _panel_changed(existing: dict, payload: dict) -> bool:
    keys = (
        'description',
        'characters',
        'location',
        'shotType',
        'cameraMovement',
        'mood',
        'action',
        'dialogue',
        'imagePrompt',
        'videoPrompt',
    )
    return any(existing.get(key) != payload.get(key) for key in keys)


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

        query = {'episodeId': episode_id, 'isActive': {'$ne': False}}
        if clip_ids:
            query['clipId'] = {'$in': clip_ids}
        clips = list(db.clips.find(query).sort('clipIndex', 1))

        if not clips:
            raise ValueError('No clips found for storyboard generation')

        total_panels = 0
        beat_clip_count = 0
        panel_clip_count = 0

        previous_beat_clip = None
        previous_beat_plan = None
        for i, clip in enumerate(clips):
            pct = 5 + int((i + 1) / len(clips) * 88)
            use_panels = _use_multi_panel(clip, mode)

            if use_panels:
                previous_beat_clip = None
                previous_beat_plan = None
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
                if not panels:
                    continue

                existing_panels = list(db.panels.find({'clipId': clip['clipId'], 'isActive': {'$ne': False}}))
                existing_by_index = {int(p.get('panelIndex', 0)): p for p in existing_panels}
                active_panel_ids: list[str] = []
                seen_indexes: set[int] = set()
                for j, panel in enumerate(panels):
                    panel_index = panel.get('panelIndex', j)
                    try:
                        panel_index = int(panel_index)
                    except (TypeError, ValueError):
                        panel_index = j
                    seen_indexes.add(panel_index)
                    core = _panel_core_fields(panel, clip, panel_index)
                    existing = existing_by_index.get(panel_index)
                    if existing:
                        next_doc = {
                            **core,
                            'updatedAt': now,
                            'isActive': True,
                        }
                        if _panel_changed(existing, core):
                            next_doc.update({
                                'imageUrl': None,
                                'videoUrl': None,
                                'status': 'draft',
                            })
                        db.panels.update_one(
                            {'panelId': existing['panelId']},
                            {
                                '$set': next_doc,
                                '$unset': {'supersededAt': ''},
                            },
                        )
                        active_panel_ids.append(existing['panelId'])
                        continue

                    panel_id = f"panel_{uuid4().hex[:12]}"
                    db.panels.insert_one({
                        'panelId': panel_id,
                        'clipId': clip['clipId'],
                        'episodeId': episode_id,
                        'projectId': project_id,
                        **core,
                        'imageUrl': None,
                        'videoUrl': None,
                        'status': 'draft',
                        'isActive': True,
                        'createdAt': now,
                        'updatedAt': now,
                    })
                    active_panel_ids.append(panel_id)

                stale_panel_ids = [
                    panel['panelId']
                    for panel in existing_panels
                    if int(panel.get('panelIndex', -1)) not in seen_indexes
                ]
                if stale_panel_ids:
                    db.panels.update_many(
                        {'panelId': {'$in': stale_panel_ids}},
                        {'$set': {'isActive': False, 'supersededAt': now, 'updatedAt': now}},
                    )

                if active_panel_ids:
                    clip_update = {
                        'panelIds': active_panel_ids,
                        'storyboardPlan': None,
                        'updatedAt': now,
                    }
                    if clip.get('storyboardPlan') is not None:
                        clip_update['archivedStoryboardPlan'] = clip.get('storyboardPlan')
                    db.clips.update_one(
                        {'clipId': clip['clipId']},
                        {'$set': clip_update},
                    )
                    total_panels += len(active_panel_ids)
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
                previous_beat_plan = apply_beat_frame_plan_for_clip(
                    db, now, episode_id, project_id, clip,
                    characters=characters,
                    locations=locations,
                    art_style=art_style,
                    language=language,
                    ai_settings=ai_settings,
                    previous_clip=previous_beat_clip,
                    previous_storyboard_plan=previous_beat_plan,
                )
                previous_beat_clip = {**clip, 'storyboardPlan': previous_beat_plan}
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
