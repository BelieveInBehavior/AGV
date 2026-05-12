"""MongoDB 工具 — 冷数据存取"""

from pymongo import MongoClient
from pymongo.database import Database
import config

_client: MongoClient | None = None
_db: Database | None = None


def get_db() -> Database:
    global _client, _db
    if _db is None:
        _client = MongoClient(config.MONGODB_URI, serverSelectionTimeoutMS=10000)
        _db = _client[config.MONGODB_DB]
    return _db
