"""
角色状态图：Redis 热缓存 + MongoDB characterStates 冷存储。

cache key = SHA256(characterId | outfit | emotion | baseImageUrl)
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any

import config


def _state_hash(character_id: str, outfit: str, emotion: str, base_url: str) -> str:
    raw = '|'.join([
        (character_id or '').strip(),
        (outfit or '').strip(),
        (emotion or '').strip(),
        (base_url or '').strip(),
    ])
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def resolve_character_row(project: dict | None, name: str) -> tuple[str, str]:
    """返回 (characterId, baseReferenceImageUrl)。characterId 优先 Mongo 字段，否则为列表下标字符串。"""
    if not project or not name:
        return '', ''
    name = (name or '').strip()
    for i, c in enumerate(project.get('characters') or []):
        if (c.get('name') or '').strip() != name:
            continue
        cid = str(c.get('characterId') or c.get('id') or i)
        base = (c.get('referenceImageUrl') or '').strip()
        return cid, base
    return '', ''


def get_cached_state_url(redis_cli, state_id: str) -> str | None:
    key = f'cs:{state_id}'
    u = redis_cli.get(key)
    return u if u else None


def set_cached_state_url(redis_cli, state_id: str, url: str, ttl_seconds: int) -> None:
    key = f'cs:{state_id}'
    redis_cli.setex(key, ttl_seconds, url)


def load_state_doc(db, state_id: str) -> dict | None:
    return db.characterStates.find_one({'_id': state_id})


def get_or_create_character_state_image(
    *,
    db,
    redis_cli,
    project_id: str,
    character_id: str,
    character_name: str,
    outfit: str,
    emotion: str,
    base_image_url: str,
    provider_cfg: dict[str, Any],
    width: int,
    height: int,
    art_style: str,
) -> str | None:
    """
    不再额外生成角色状态图：直接复用项目角色基础参考图 URL。
    衣着/情绪信息通过文本提示（由 build_image_prompt / multi_ref_image_gen prompt 承担）补充。
    """
    base = (base_image_url or '').strip()
    if not base:
        return None

    state_id = _state_hash(character_id, outfit, emotion, base)

    # 仅做缓存命中计数，不重复生成
    hit = get_cached_state_url(redis_cli, state_id)
    if hit:
        db.characterStates.update_one(
            {'_id': state_id},
            {'$set': {'lastUsedAt': datetime.now(timezone.utc)}, '$inc': {'usageCount': 1}},
        )
        return hit

    doc = load_state_doc(db, state_id)
    if doc and doc.get('stateImageUrl'):
        url = doc['stateImageUrl']
        set_cached_state_url(redis_cli, state_id, url, config.CHARACTER_STATE_CACHE_TTL_SECONDS)
        db.characterStates.update_one(
            {'_id': state_id},
            {'$set': {'lastUsedAt': datetime.now(timezone.utc)}, '$inc': {'usageCount': 1}},
        )
        return url

    # 直接用原始参考图作为状态图 URL
    now = datetime.now(timezone.utc)
    db.characterStates.update_one(
        {'_id': state_id},
        {
            '$set': {
                'projectId': project_id,
                'characterId': character_id,
                'characterName': character_name,
                'outfit': outfit,
                'emotion': emotion,
                'baseImageUrl': base,
                'stateImageUrl': base,
                'lastUsedAt': now,
            },
            '$setOnInsert': {'createdAt': now},
            '$inc': {'usageCount': 1},
        },
        upsert=True,
    )
    set_cached_state_url(redis_cli, state_id, base, config.CHARACTER_STATE_CACHE_TTL_SECONDS)
    return base
