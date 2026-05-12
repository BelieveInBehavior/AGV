"""
Redis 工具 — 热数据存取 + SSE 进度发布

热数据设计:
  task:{taskId}  →  HASH { status, progress, message, error }  TTL: 24h
  sse:events     →  pub/sub channel
"""

import json
import time
import redis as redis_lib
import config
from datetime import datetime, timezone
from utils.db import get_db

_pool = None

def get_redis() -> redis_lib.Redis:
    global _pool
    if _pool is None:
        _pool = redis_lib.ConnectionPool.from_url(config.REDIS_URL, decode_responses=True)
    return redis_lib.Redis(connection_pool=_pool)


# ── 任务热状态 ──────────────────────────────────────────────────────

def set_task_state(task_id: str, **fields):
    """更新 Redis 中的任务状态（热数据）"""
    r = get_redis()
    key = f'task:{task_id}'
    r.hset(key, mapping={k: str(v) for k, v in fields.items()})
    r.expire(key, config.TASK_TTL_SECONDS)


def get_task_state(task_id: str) -> dict:
    r = get_redis()
    return r.hgetall(f'task:{task_id}')


def update_task_document(task_id: str, **fields):
    """同步任务冷数据，保证 Redis 过期后仍可查询最终状态。"""
    updates = {k: v for k, v in fields.items() if v is not None}
    updates['updatedAt'] = datetime.now(timezone.utc)
    get_db().tasks.update_one({'taskId': task_id}, {'$set': updates})


# ── SSE 进度广播 ────────────────────────────────────────────────────

def publish_progress(task_id: str, progress: int, message: str, stage: str = ''):
    """发布进度事件到 SSE 频道"""
    r = get_redis()
    set_task_state(task_id, status='running', progress=progress, message=message)
    update_task_document(task_id, status='running', progress=progress, message=message)
    payload = json.dumps({
        'type': 'task.progress',
        'taskId': task_id,
        'progress': progress,
        'message': message,
        'stage': stage,
        'timestamp': int(time.time() * 1000),
    })
    r.publish(config.SSE_CHANNEL, payload)


def publish_complete(task_id: str, result: dict = None):
    """发布任务完成事件"""
    r = get_redis()
    set_task_state(task_id, status='completed', progress=100)
    update_task_document(
        task_id,
        status='completed',
        progress=100,
        message='任务完成',
        error=None,
        result=result or {},
    )
    payload = json.dumps({
        'type': 'task.completed',
        'taskId': task_id,
        'result': result or {},
        'timestamp': int(time.time() * 1000),
    })
    r.publish(config.SSE_CHANNEL, payload)


def publish_error(task_id: str, error: str):
    """发布任务失败事件"""
    r = get_redis()
    set_task_state(task_id, status='failed', error=error)
    update_task_document(task_id, status='failed', error=error, message='任务失败')
    payload = json.dumps({
        'type': 'task.error',
        'taskId': task_id,
        'error': error,
        'timestamp': int(time.time() * 1000),
    })
    r.publish(config.SSE_CHANNEL, payload)
