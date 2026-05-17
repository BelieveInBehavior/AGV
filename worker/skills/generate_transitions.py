"""
首尾帧之间衔接描述（汉语）：按剧集一批 LLM，供后续视频阶段使用。
"""

from __future__ import annotations

from typing import Any

from skills.llm_chat import chat_completion_text
from utils.ai_settings import get_default_ai_settings
from utils.json_utils import safe_parse_json

_SYSTEM = """You are a film editor writing concise camera/action TRANSITION instructions between consecutive short video beats.
Input: ordered clips with Chinese descriptions of first and last keyframes per beat.
Output: JSON array, SAME LENGTH and SAME ORDER as input clips.
Each element: {"clipId": "<must match input>", "transition_from_prev": "Chinese text or empty string"}
The FIRST element MUST have transition_from_prev as "" (empty string).
For clip index i>=1, describe how the shot flows from the previous clip's last frame to this clip's first frame.

Rules:
- JSON only, no markdown
"""


def generate_transitions_batch(
    clips_payload: list[dict[str, str]],
    *,
    ai_settings: dict[str, Any] | None = None,
) -> dict[str, str]:
    """
    Args:
        clips_payload: [{"clipId", "first_desc", "last_desc"}, ...] in story order
    Returns:
        clipId -> transition_from_prev (zh)
    """
    if not clips_payload:
        return {}
    settings = ai_settings or get_default_ai_settings()
    lines = []
    for i, row in enumerate(clips_payload):
        lines.append(
            f'{i + 1}. clipId={row.get("clipId")} first_frame={row.get("first_desc", "")} '
            f'last_frame={row.get("last_desc", "")}'
        )
    user = 'Clips in order:\n' + '\n'.join(lines)
    text = chat_completion_text(
        system_prompt=_SYSTEM,
        user_prompt=user,
        ai_settings=settings,
        max_tokens=2048,
        temperature=0.25,
    )
    parsed = safe_parse_json(text)
    if isinstance(parsed, dict):
        parsed = parsed.get('transitions') or parsed.get('items') or parsed.get('results')
    if not isinstance(parsed, list):
        return {row['clipId']: '' for row in clips_payload}

    out: dict[str, str] = {}
    for i, row in enumerate(clips_payload):
        cid = str(row.get('clipId') or '')
        if i == 0:
            out[cid] = ''
            continue
        t = ''
        if i < len(parsed) and isinstance(parsed[i], dict):
            t = parsed[i].get('transition_from_prev') or ''
        out[cid] = t
    return out


def run_transition_batch_for_episode(
    db,
    episode_id: str,
    *,
    ai_settings: dict[str, Any],
) -> int:
    """用当前 Mongo clips 的 storyboardPlan 描述跑一次衔接；返回更新条数。"""
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    clips = list(db.clips.find({'episodeId': episode_id}).sort('clipIndex', 1))
    payload: list[dict[str, str]] = []
    for c in clips:
        plan = c.get('storyboardPlan') or {}
        ff = plan.get('first_frame') or {}
        lf = plan.get('last_frame') or {}
        if not isinstance(ff, dict) or not isinstance(lf, dict):
            continue
        payload.append({
            'clipId': c['clipId'],
            'first_desc': (ff.get('description') or '')[:800],
            'last_desc': (lf.get('description') or '')[:800],
        })
    if len(payload) < 2:
        return 0
    trans = generate_transitions_batch(payload, ai_settings=ai_settings)
    n = 0
    for row in payload:
        cid = str(row['clipId'])
        t = trans.get(cid)
        if t is None:
            t = ''
        db.clips.update_one(
            {'clipId': cid, 'episodeId': episode_id},
            {'$set': {'storyboardPlan.transition_from_prev': t, 'updatedAt': now}},
        )
        n += 1
    return n
