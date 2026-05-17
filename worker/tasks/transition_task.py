"""
可选 Celery 任务：仅批量补全 transition_from_prev（不经过生图）。
"""

from celery_app import app
from skills.generate_transitions import run_transition_batch_for_episode
from utils.ai_settings import get_ai_settings_for_project
from utils.db import get_db


@app.task(name='tasks.transition_task.generate_beat_transitions', queue='storyboard')
def generate_beat_transitions(project_id: str, episode_id: str, **kwargs):
    db = get_db()
    ai = get_ai_settings_for_project(db, project_id)
    n = run_transition_batch_for_episode(db, episode_id, ai_settings=ai)
    return {'clipsUpdated': n}
