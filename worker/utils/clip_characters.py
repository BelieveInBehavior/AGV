"""
跨 clip 角色在场回填：落实 analyze_story 提示中的「相邻 clip 连贯性回查」。

LLM 常把环境建立镜头（如清晨卧室光线变化）的 characters 只填主角，
遗漏同床已睡着的配角；下一段醒来/互动时才列出两人。本模块向前回填。
"""

from __future__ import annotations

import re
from typing import Any

# 下一段若出现这些词且与角色名邻近，视为「本段才进入场景」，不回填到上一段
_ENTER_NEAR_NAME = re.compile(
    r'(?:进入|到达|走进|推门|进门|闯入|现身|赶来|到来|开门进入|推门进入|'
    r'走进来|闯进来|推门而入|推门走进|出现在|来到)'
)

# 全段级进入（未点名也可判定本段为「入场」镜头）
_ENTER_GLOBAL = re.compile(
    r'(?:有人)?(?:进入|走进|推门进入|闯入|赶到|来到)(?:了)?(?:该|此|这个)?(?:房间|卧室|室内|场景|空间)'
)


def _clip_text(clip: dict[str, Any]) -> str:
    return f"{clip.get('content') or ''}\n{clip.get('summary') or ''}"


def character_enters_in_clip(character_name: str, clip: dict[str, Any]) -> bool:
    """该角色是否在本 clip 正文中被描写为「进入/到达」场景。"""
    if not character_name:
        return False
    text = _clip_text(clip)
    if not text.strip():
        return False
    if _ENTER_GLOBAL.search(text):
        return True
    for m in _ENTER_NEAR_NAME.finditer(text):
        start = max(0, m.start() - 40)
        end = min(len(text), m.end() + 40)
        window = text[start:end]
        if character_name in window:
            return True
    return False


def _same_location(a: dict[str, Any], b: dict[str, Any]) -> bool:
    loc_a = (a.get('location') or '').strip()
    loc_b = (b.get('location') or '').strip()
    if not loc_a or not loc_b:
        return True
    if loc_a == loc_b:
        return True
    # 「卧室_清晨」与「卧室」等同场
    base_a = loc_a.split('_')[0]
    base_b = loc_b.split('_')[0]
    return base_a == base_b


def backfill_clip_characters(clips: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    对相邻 clip 做向前回填：下一段在场且本段无「进入」描写的角色，补入上一段 characters。
    原地修改并返回按 clipIndex 排序的列表。
    """
    if not clips:
        return clips

    ordered = sorted(clips, key=lambda c: c.get('clipIndex', 0))
    for i in range(len(ordered) - 1):
        curr = ordered[i]
        nxt = ordered[i + 1]
        if not _same_location(curr, nxt):
            continue

        curr_list = list(curr.get('characters') or [])
        curr_set = set(curr_list)
        for name in nxt.get('characters') or []:
            if not name or name in curr_set:
                continue
            if character_enters_in_clip(name, nxt):
                continue
            curr_list.append(name)
            curr_set.add(name)
        curr['characters'] = curr_list

    return ordered
