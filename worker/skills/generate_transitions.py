"""
首尾帧之间衔接描述（中文）：按剧集一批 LLM，供后续视频阶段使用。
对齐 waoowaoo 镜头连续性思维。
"""

from __future__ import annotations

from typing import Any

from skills.llm_chat import chat_completion_text
from utils.ai_settings import get_default_ai_settings
from utils.json_utils import safe_parse_json

_SYSTEM = """你是专业剪辑师，为连续短剧情节段撰写「镜头衔接」说明（transition_from_prev）。

【输入】
按顺序给出各 clip 的首帧、末帧中文画面描述。

【输出】
JSON 数组，长度与顺序与输入 clips 完全一致。每项：
{"clipId": "必须与输入一致", "transition_from_prev": "中文衔接说明或空字符串"}

【规则】
1. 第一项 transition_from_prev 必须为空字符串 ""
2. 从第二项起：描述上一段末帧到本段首帧的运镜/动作/光线如何衔接（如切、溶、摇镜、角色走位承接）
3. 保持空间与光线连贯；勿编造原文没有的新剧情
4. 只返回 JSON，禁止 markdown
5. JSON 字符串内勿出现未转义英文双引号，原文引号用「」
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
            f'{i + 1}. clipId={row.get("clipId")} 首帧={row.get("first_desc", "")} '
            f'末帧={row.get("last_desc", "")}'
        )
    user = '按顺序的情节段：\n' + '\n'.join(lines)
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
