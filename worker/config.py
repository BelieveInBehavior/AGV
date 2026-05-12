"""Worker 配置 — 从环境变量加载"""
import os
from dotenv import load_dotenv

_worker_dir = os.path.dirname(os.path.abspath(__file__))
_root_dir = os.path.abspath(os.path.join(_worker_dir, '..'))

# 根目录 → worker 目录 → server/.env（后覆盖前；override=True 否则后加载无法覆盖已存在的键）
load_dotenv(os.path.join(_root_dir, '.env'))
load_dotenv(os.path.join(_worker_dir, '.env'), override=True)
load_dotenv(os.path.join(_root_dir, 'server', '.env'), override=True)

REDIS_URL = os.getenv('REDIS_URL', 'redis://localhost:6379/0')
MONGODB_URI = os.getenv('MONGODB_URI', 'mongodb://localhost:27017')
MONGODB_DB = os.getenv('MONGODB_DB_NAME', 'agv')

LLM_BASE_URL = os.getenv('LLM_BASE_URL', 'https://api.openai.com/v1')
LLM_API_KEY = os.getenv('LLM_API_KEY', '')
LLM_MODEL = os.getenv('LLM_MODEL', 'gpt-4o-mini')

# 视频生成（预留：设置页可配置，任务接入第三方时再读）
VIDEO_API_BASE_URL = os.getenv('VIDEO_API_BASE_URL', '')
VIDEO_API_KEY = os.getenv('VIDEO_API_KEY', '')
VIDEO_MODEL = os.getenv('VIDEO_MODEL', '')

FAL_API_KEY = os.getenv('FAL_API_KEY', '')
FAL_IMAGE_MODEL = os.getenv('FAL_IMAGE_MODEL', 'fal-ai/flux/schnell')

# Celery
CELERY_BROKER_URL = REDIS_URL
CELERY_RESULT_BACKEND = REDIS_URL
CELERY_WORKER_CONCURRENCY = int(os.getenv('CELERY_WORKER_CONCURRENCY', '2'))
CELERY_TASK_SOFT_TIME_LIMIT = int(os.getenv('CELERY_TASK_SOFT_TIME_LIMIT', '900'))
CELERY_TASK_TIME_LIMIT = int(os.getenv('CELERY_TASK_TIME_LIMIT', '1200'))

# Redis key TTL
TASK_TTL_SECONDS = 86400       # 24h — 任务热状态
SSE_CHANNEL = 'sse:events'    # pub/sub 频道名
