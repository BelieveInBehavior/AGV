"""
Celery Task: 故事分析

无状态设计:
  - 接收 task_id, episode_id, project_id
  - 从 MongoDB (冷数据) 读取全部所需数据
  - 调用 analyze_story_skill (LLM)
  - 将结果写回 MongoDB
  - 通过 Redis pub/sub 广播进度 → Node.js SSE → 前端
"""

from datetime import datetime, timezone
from uuid import uuid4

from celery_app import app
from skills.analyze_story import analyze_story_skill
from utils.ai_settings import get_ai_settings_for_project
from utils.db import get_db
from utils.redis_client import publish_progress, publish_complete, publish_error, set_task_state


@app.task(
    name='tasks.story_task.analyze_story',
    bind=True,
    max_retries=2,
    default_retry_delay=10,
    queue='story',
)
def analyze_story(self, task_id: str, episode_id: str, project_id: str, **kwargs):
    """
    故事分析 Celery Task

    冷热数据分离:
      热 (Redis): 任务进度、状态
      冷 (MongoDB): episode 文本、clips、characters、locations
    """
    db = get_db()
    now = datetime.now(timezone.utc)

    try:
        # ── 热数据: 标记任务开始 ──────────────────────────────────────
        set_task_state(task_id, status='running', progress=5, message='开始读取故事数据...')

        # ── 冷数据: 从 MongoDB 读取 ───────────────────────────────────
        episode = db.episodes.find_one({'episodeId': episode_id})
        project = db.projects.find_one({'projectId': project_id})

        if not episode:
            raise ValueError(f'Episode {episode_id} not found')

        publish_progress(task_id, 15, '正在调用 AI 分析故事...', 'llm_call')

        db.episodes.update_one(
            {'episodeId': episode_id},
            {'$set': {'status': 'analyzing', 'updatedAt': now}},
        )

        # ── Skill: LLM（OpenAI 兼容，用户可在设置页配置） ────────────────
        ai_settings = get_ai_settings_for_project(db, project_id)
        result = analyze_story_skill(
            text=episode['novelText'],
            language=project.get('language', 'zh') if project else 'zh',
            ai_settings=ai_settings,
        )

        characters = result.get('characters', [])
        locations = result.get('locations', [])
        clips = result.get('clips', [])

        publish_progress(
            task_id, 65,
            f'分析完成: {len(characters)} 角色 / {len(locations)} 场景 / {len(clips)} 情节',
            'saving',
        )

        # ── 冷数据: 写回 MongoDB ──────────────────────────────────────

        # 合并角色和场景（不覆盖已有数据）
        existing_chars = {c['name']: c for c in (project.get('characters', []) if project else [])}
        for c in characters:
            if c['name'] not in existing_chars:
                existing_chars[c['name']] = c

        existing_locs = {l['name']: l for l in (project.get('locations', []) if project else [])}
        for l in locations:
            if l['name'] not in existing_locs:
                existing_locs[l['name']] = l

        db.projects.update_one(
            {'projectId': project_id},
            {'$set': {
                'characters': list(existing_chars.values()),
                'locations': list(existing_locs.values()),
                'updatedAt': now,
            }},
        )

        # 删除旧 clips，插入新的
        db.clips.delete_many({'episodeId': episode_id})

        clip_docs = []
        for i, clip in enumerate(clips):
            clip_id = f"clip_{uuid4().hex[:12]}"
            clip_docs.append({
                'clipId': clip_id,
                'episodeId': episode_id,
                'projectId': project_id,
                'clipIndex': clip.get('clipIndex', i),
                'content': clip.get('content', ''),
                'summary': clip.get('summary', ''),
                'characters': clip.get('characters', []),
                'location': clip.get('location', ''),
                'mood': clip.get('mood', ''),
                'panelIds': [],
                'createdAt': now,
                'updatedAt': now,
            })

        if clip_docs:
            db.clips.insert_many(clip_docs)

        clip_ids = [c['clipId'] for c in clip_docs]
        db.episodes.update_one(
            {'episodeId': episode_id},
            {'$set': {'status': 'analyzed', 'clipIds': clip_ids, 'updatedAt': now}},
        )

        # ── 完成 ─────────────────────────────────────────────────────
        result_data = {
            'clipCount': len(clip_docs),
            'characterCount': len(existing_chars),
            'locationCount': len(existing_locs),
        }
        publish_complete(task_id, result_data)
        return result_data

    except Exception as exc:
        err_msg = str(exc)
        db.episodes.update_one(
            {'episodeId': episode_id},
            {'$set': {'status': 'draft', 'updatedAt': now}},
        )
        if self.request.retries < self.max_retries:
            set_task_state(task_id, status='retrying', message=f'任务重试中: {err_msg}')
            raise self.retry(exc=exc)

        publish_error(task_id, err_msg)
        raise exc
