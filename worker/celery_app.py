"""
Celery 应用配置

架构:
  Node.js API  →  Redis Broker (publish)  →  Celery Worker (consume)
  Celery Worker  →  Redis pub/sub (progress)  →  Node.js SSE  →  前端

Redis 角色:
  - Celery Broker: 任务队列 (list: celery)
  - Result Backend: 任务结果存储
  - Hot State: task:{taskId} hash (进度/状态)
  - SSE Channel: sse:events pub/sub
"""

from celery import Celery
from celery.signals import worker_process_init

import config


@worker_process_init.connect
def _init_worker_process(**_kwargs):
    from utils import pipeline_telemetry

    pipeline_telemetry.init_otel()

app = Celery('agv_worker')

app.conf.update(
    broker_url=config.CELERY_BROKER_URL,
    result_backend=config.CELERY_RESULT_BACKEND,

    # 序列化
    task_serializer='json',
    result_serializer='json',
    accept_content=['json'],

    # 任务路由
    task_routes={
        'tasks.story_task.*':             {'queue': 'story'},
        'tasks.storyboard_task.*':        {'queue': 'storyboard'},
        'tasks.beat_prompt_task.*':       {'queue': 'storyboard'},
        'tasks.transition_task.*':        {'queue': 'storyboard'},
        'tasks.image_task.*':             {'queue': 'image'},
        'tasks.reference_image_task.*':   {'queue': 'image'},
        'tasks.video_task.*':             {'queue': 'video'},
    },

    # 可靠性配置
    task_acks_late=True,          # 任务完成后才 ack，崩溃可重试
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,  # 每个 worker 每次只取 1 个任务
    worker_concurrency=config.CELERY_WORKER_CONCURRENCY,
    broker_connection_retry_on_startup=True,
    broker_transport_options={
        'visibility_timeout': config.CELERY_TASK_TIME_LIMIT + 300,
    },

    # 执行保护
    task_soft_time_limit=config.CELERY_TASK_SOFT_TIME_LIMIT,
    task_time_limit=config.CELERY_TASK_TIME_LIMIT,

    # 结果保留 24h
    result_expires=86400,

    # 时区
    timezone='Asia/Shanghai',
    enable_utc=True,
)

# 自动发现任务模块
app.autodiscover_tasks(['tasks'])
