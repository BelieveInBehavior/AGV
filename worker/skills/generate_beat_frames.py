"""
Skill: 情节首尾关键帧规划 v2 — 扁平 storyboardPlan，场景/角色状态分离。
"""

from typing import Any

from skills.llm_chat import chat_completion_text
from utils.ai_settings import get_default_ai_settings
from utils.json_utils import safe_parse_json

_SYSTEM_PROMPT = """You are a professional film director planning keyframes for short interactive video beats.
Your task is NOT a multi-panel comic strip — produce exactly TWO key images: opening frame and closing frame of this beat, plus director notes.

RULES:
1. Respond with valid JSON only — no markdown, no prose
2. Single plan only (no candidate variants).
3. first_frame = story opening state, last_frame = end state before the next narrative beat
4. motion_prompt: one detailed paragraph (Chinese) describing camera movement and action BETWEEN first and last frames
5. continuity_notes: bullet-style string (Chinese) for wardrobe, props, lighting consistency
6. dramatic_beat: one sentence (Chinese) summarizing the narrative turn
7. scene_prompt fields (English): shot framing, camera angle, lighting, environment, props, character ACTIONS/GESTURES only — NO physical appearance (no age, ethnicity, hair, eyes, face shape, body type). Reference images + character outfits handle look.
8. description fields: Chinese shot caption for humans
9. characters array (per frame): each visible character with name (as given), outfit (Chinese), emotion/acting (Chinese)
10. included_character_ids: string ids for characters that appear (use order from user message, e.g. "0","1" matching list position, or names if no ids)
11. Do NOT output transition_from_prev (it is filled later by batch step)

SCENE PROMPT QUALITY same as former image_prompt guardrails (G1–G4): shot-body coherence, texture containment, pose simplification, one focal subject.

OUTPUT FORMAT (JSON):
{
  "dramatic_beat": "string (zh)",
  "motion_prompt": "string (zh)",
  "continuity_notes": "string (zh)",
  "included_character_ids": ["0", "1"],
  "first_frame": {
    "description": "string (zh)",
    "scene_prompt": "string (en)",
    "characters": [{"name": "...", "outfit": "...", "emotion": "..."}]
  },
  "last_frame": {
    "description": "string (zh)",
    "scene_prompt": "string (en)",
    "characters": [{"name": "...", "outfit": "...", "emotion": "..."}]
  }
}
"""


def _normalize_characters(raw_list: Any) -> list[dict]:
    out: list[dict] = []
    if not isinstance(raw_list, list):
        return out
    for ch in raw_list:
        if isinstance(ch, dict):
            out.append({
                'name': ch.get('name', '') or '',
                'outfit': ch.get('outfit', '') or '',
                'emotion': ch.get('emotion', '') or '',
            })
    return out


def _normalize_frame(raw: dict | None) -> dict:
    r = raw if isinstance(raw, dict) else {}
    img_urls = r.get('characterImageUrls')
    if not isinstance(img_urls, dict):
        img_urls = {}
    return {
        'description': r.get('description', '') or '',
        'scene_prompt': r.get('scene_prompt') or r.get('scenePrompt') or '',
        'characters': _normalize_characters(r.get('characters')),
        'characterImageUrls': dict(img_urls),
        'imageUrl': r.get('imageUrl') or r.get('image_url'),
        'status': r.get('status'),
        'imageError': r.get('imageError'),
        'imagePromptUsed': r.get('imagePromptUsed'),
    }


def _normalize_plan(raw: dict) -> dict:
    ff = _normalize_frame(raw.get('first_frame'))
    lf = _normalize_frame(raw.get('last_frame'))
    return {
        'dramatic_beat': raw.get('dramatic_beat', '') or '',
        'motion_prompt': raw.get('motion_prompt', '') or '',
        'continuity_notes': raw.get('continuity_notes', '') or '',
        'transition_from_prev': raw.get('transition_from_prev') or '',
        'included_character_ids': raw.get('included_character_ids') or [],
        'first_frame': ff,
        'last_frame': lf,
    }


def generate_beat_frames_skill(
    clip: dict,
    characters: list,
    locations: list,
    art_style: str = 'cinematic realistic',
    language: str = 'zh',
    ai_settings: dict[str, Any] | None = None,
) -> dict:
    """为单个情节片段生成扁平 storyboardPlan（首尾帧）。"""
    settings = ai_settings or get_default_ai_settings()

    clip_chars = list(clip.get('characters') or [])
    id_lines = []
    for i, name in enumerate(clip_chars):
        id_lines.append(f'  - id "{i}" name "{name}"')
    char_ctx = '\n'.join(id_lines) if id_lines else 'No specific characters'

    char_details = '\n'.join(
        f"- {c['name']}: {c.get('description', '')[:400]}"
        for c in characters
        if c.get('name') in clip_chars
    ) or ''

    loc_info = next((l for l in locations if l.get('name') == clip.get('location')), None)
    loc_ctx = (
        f"{loc_info['name']}: {loc_info.get('description', '')}"
        if loc_info
        else clip.get('location', 'Unknown')
    )

    user_prompt = f"""Art style name to mention inside each English scene_prompt: {art_style}

Location: {loc_ctx}

Characters in beat (use these ids in included_character_ids when possible):
{char_ctx}

Character briefs (do not copy appearance into scene_prompt):
{char_details}

Scene summary: {clip.get('summary', '')}

Scene content:
{clip.get('content', '')}

Clip mood: {clip.get('mood', '')}

Generate the JSON plan. Each scene_prompt must be English and include the style phrase "{art_style}"."""

    text_content = chat_completion_text(
        system_prompt=_SYSTEM_PROMPT,
        user_prompt=user_prompt,
        ai_settings=settings,
        max_tokens=4096,
        temperature=0.35,
    )

    parsed = safe_parse_json(text_content)
    if isinstance(parsed, dict) and 'storyboard_plan' in parsed:
        parsed = parsed['storyboard_plan']
    if not isinstance(parsed, dict):
        parsed = {}
    plan = _normalize_plan(parsed)
    return plan
