"""
Celery Task: 剧集输出质量评估（反思机制）

调用评估 Skill → 将评估结果写入 episodes.evaluation，
不改写 clips / characters / locations 等已有生成数据。
"""

from datetime import datetime, timezone

from celery_app import app
from skills.evaluate_episode import evaluate_episode_skill
from utils.ai_settings import get_ai_settings_for_project
from utils.db import get_db
from utils.redis_client import publish_progress, publish_complete, publish_error, set_task_state


@app.task(
    name='tasks.evaluation_task.evaluate_episode_outputs',
    bind=True,
    max_retries=1,
    default_retry_delay=15,
    queue='storyboard',
)
def evaluate_episode_outputs(
    self,
    task_id: str,
    episode_id: str,
    project_id: str,
    scopes: list | None = None,
    **kwargs,
):
    db = get_db()
    now = datetime.now(timezone.utc)

    try:
        set_task_state(task_id, status='running', progress=5, message='读取剧集数据...')

        project = db.projects.find_one({'projectId': project_id})
        episode = db.episodes.find_one({'episodeId': episode_id})
        if not episode:
            raise ValueError(f'Episode {episode_id} not found')
        if not project:
            raise ValueError(f'Project {project_id} not found')

        clips = list(db.clips.find({'episodeId': episode_id}).sort('clipIndex', 1))
        if not clips:
            raise ValueError('没有可评估的情节片段，请先完成故事分析')

        requested_scopes = scopes or ['story_analysis', 'beat_frames']

        if 'beat_frames' in requested_scopes:
            has_plan = any(
                isinstance(c.get('storyboardPlan'), dict) and c['storyboardPlan'].get('first_frame')
                for c in clips
            )
            if not has_plan:
                if len(requested_scopes) > 1:
                    requested_scopes = [s for s in requested_scopes if s != 'beat_frames']
                else:
                    raise ValueError('没有首尾帧 Prompt 可评估，请先生成首尾帧 Prompt')

        ai_settings = get_ai_settings_for_project(db, project_id)
        publish_progress(task_id, 15, '正在调用 AI 评估...', 'evaluating')

        result = evaluate_episode_skill(
            episode=episode,
            project=project,
            clips=clips,
            scopes=requested_scopes,
            ai_settings=ai_settings,
        )

        publish_progress(task_id, 85, '保存评估结果...', 'saving')

        eval_doc = {
            'status': 'completed',
            'taskId': task_id,
            'scopes': requested_scopes,
            'createdAt': now,
            **result,
        }
        history_entry = {
            'taskId': task_id,
            'createdAt': now,
            'score': result.get('overall', {}).get('score', 0),
            'verdict': result.get('overall', {}).get('verdict', 'fail'),
            'scopes': requested_scopes,
        }

        db.episodes.update_one(
            {'episodeId': episode_id},
            {
                '$set': {'evaluation': eval_doc, 'updatedAt': now},
                '$push': {
                    'evaluationHistory': {
                        '$each': [history_entry],
                        '$slice': -5,
                    },
                },
            },
        )

        result_summary = {
            'score': result.get('overall', {}).get('score', 0),
            'grade': result.get('overall', {}).get('grade', 'D'),
            'verdict': result.get('overall', {}).get('verdict', 'fail'),
            'scopes': requested_scopes,
        }
        publish_complete(task_id, result_summary)
        return result_summary

    except Exception as exc:
        err_msg = str(exc)
        if self.request.retries < self.max_retries:
            set_task_state(task_id, status='retrying', message=f'任务重试中: {err_msg}')
            raise self.retry(exc=exc)

        publish_error(task_id, err_msg)
        raise exc
