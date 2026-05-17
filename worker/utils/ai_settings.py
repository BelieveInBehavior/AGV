"""用户 AI 设置：Mongo user_ai_settings + 环境变量默认值（OpenAI 兼容协议）"""

from __future__ import annotations

import copy
from typing import Any

import config


def _default_image_caps(provider: str) -> tuple[bool, int]:
    p = (provider or '').lower()
    if p == 'gemini':
        return True, 6
    if p == 'doubao':
        return True, 4
    # fal / none / 其他
    return False, 1


def get_default_ai_settings() -> dict[str, Any]:
    """进程级默认（.env / worker/config）"""
    img_provider = 'fal' if (config.FAL_API_KEY or '') else 'none'
    sup, mx = _default_image_caps(img_provider)
    return {
        'llm': {
            'baseUrl': (config.LLM_BASE_URL or '').strip().rstrip('/') or 'https://api.openai.com/v1',
            'apiKey': config.LLM_API_KEY or '',
            'model': config.LLM_MODEL or 'gpt-4o-mini',
        },
        'image': {
            'provider': img_provider,
            'apiKey': config.FAL_API_KEY or '',
            'model': config.FAL_IMAGE_MODEL or 'fal-ai/flux/schnell',
            'supportsMultiReference': sup,
            'maxReferenceImages': mx,
        },
        'video': {
            'baseUrl': (config.VIDEO_API_BASE_URL or '').strip().rstrip('/') or '',
            'apiKey': config.VIDEO_API_KEY or '',
            'model': config.VIDEO_MODEL or '',
        },
    }


def _merge_llm(doc: dict | None, base: dict) -> dict:
    out = copy.deepcopy(base['llm'])
    if not doc:
        return out
    if doc.get('llmBaseUrl'):
        out['baseUrl'] = str(doc['llmBaseUrl']).strip().rstrip('/')
    if doc.get('llmModel'):
        out['model'] = str(doc['llmModel']).strip()
    if doc.get('llmApiKey'):
        out['apiKey'] = str(doc['llmApiKey']).strip()
    return out


def _merge_image(doc: dict | None, base: dict) -> dict:
    out = copy.deepcopy(base['image'])
    if not doc:
        return out
    if doc.get('imageProvider') in ('fal', 'none', 'gemini', 'doubao'):
        out['provider'] = doc['imageProvider']
    if doc.get('imageApiKey'):
        out['apiKey'] = str(doc['imageApiKey']).strip()
    if doc.get('imageModel'):
        out['model'] = str(doc['imageModel']).strip()

    sup, mx = _default_image_caps(out.get('provider') or 'fal')
    if doc.get('imageSupportsMultiReference') is not None:
        v = doc['imageSupportsMultiReference']
        out['supportsMultiReference'] = bool(v) if not isinstance(v, str) else v.lower() in ('1', 'true', 'yes')
    else:
        out['supportsMultiReference'] = sup
    if doc.get('imageMaxReferenceImages') is not None:
        try:
            out['maxReferenceImages'] = max(1, int(doc['imageMaxReferenceImages']))
        except (TypeError, ValueError):
            out['maxReferenceImages'] = mx
    else:
        out['maxReferenceImages'] = mx
    return out


def _merge_video(doc: dict | None, base: dict) -> dict:
    out = copy.deepcopy(base['video'])
    if not doc:
        return out
    if doc.get('videoBaseUrl'):
        out['baseUrl'] = str(doc['videoBaseUrl']).strip().rstrip('/')
    if doc.get('videoApiKey'):
        out['apiKey'] = str(doc['videoApiKey']).strip()
    if doc.get('videoModel'):
        out['model'] = str(doc['videoModel']).strip()
    return out


def merge_user_doc(doc: dict | None) -> dict[str, Any]:
    """合并 Mongo 文档与环境默认"""
    base = get_default_ai_settings()
    if not doc:
        return base
    return {
        'llm': _merge_llm(doc, base),
        'image': _merge_image(doc, base),
        'video': _merge_video(doc, base),
    }


def get_ai_settings_for_project(db, project_id: str) -> dict[str, Any]:
    """按项目的 userId 读取 user_ai_settings"""
    project = db.projects.find_one({'projectId': project_id})
    base = get_default_ai_settings()
    if not project:
        return base
    uid = project.get('userId')
    if not uid:
        return base
    doc = db.user_ai_settings.find_one({'userId': uid})
    return merge_user_doc(doc)
