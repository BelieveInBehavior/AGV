"""
Skill: 分镜生成 (Python)

纯函数 — 无 DB 副作用
输入情节片段 → OpenAI 兼容 API → 分镜面板列表
"""

from typing import Any

from skills.llm_chat import chat_completion_text
from utils.ai_settings import get_default_ai_settings
from utils.json_utils import safe_parse_json

_SYSTEM_PROMPT = """You are a professional film director and storyboard artist.
Your task is to break down a story clip into detailed visual storyboard panels.

RULES:
1. Create 3-6 panels per clip (more for action/complex scenes)
2. Each panel is a single camera shot — one moment in time
3. Include specific shot types and camera movements
4. Think cinematically — vary angles, distances, compositions
5. Always respond with valid JSON only
6. CHARACTER APPEARANCE CONSISTENCY: Each character entry has "Base appearance" — these are FIXED physical traits (face structure, hair color/style, skin tone, body type) that NEVER change across the entire film. When writing imagePrompt, you MUST copy these base traits verbatim into every panel that includes this character. Only add scene-specific costume, accessories, or expression ON TOP of the base appearance.

IMAGE PROMPT QUALITY GUARDRAILS — you MUST follow these when writing imagePrompt fields:
G1. Shot-body coherence: Only describe body parts/poses VISIBLE in the chosen framing.
    - Close-up/extreme close-up: describe ONLY face, eyes, or the specific detail in frame. NEVER mention full-body poses (kneeling, sitting, standing) — the camera cannot see them.
    - Medium shot (waist up): do NOT describe feet, legs, or ground-level actions.
    - Wide/full shot: do NOT describe micro-expressions or pore-level skin detail.
G2. Liquid/texture containment: Tears, sweat, rain, blood etc. must be described as LOCAL details on a specific surface, never as ambient atmosphere.
    - BAD: "teary eyes, vulnerable mood" (model spreads wetness everywhere)
    - GOOD: "a single tear rolling down her left cheek, eyes slightly reddened at the lower lids"
    - For rain/wet environments: describe wet surfaces explicitly ("rain-slicked asphalt") rather than general "wet/rainy" adjectives.
G3. Pose simplification: Avoid complex articulated poses (kneeling, crouching, twisted torso, foreshortened limbs) that frequently cause anatomy errors. Prefer:
    - Implication over explicit pose: "low camera angle looking up at her face" instead of "she kneels on the ground"
    - Props/environment to suggest action: "scattered books on the ground beside her lowered hand" instead of describing the full kneeling pose
    - If a complex pose is essential, use a wider shot (medium or wide) where anatomy is less scrutinized.
G4. One focal subject per prompt: Each imagePrompt should have ONE clear visual focus. Do not pack multiple competing details (e.g. "teary eyes AND swollen ankle AND scattered books AND club entrance" is too many focal points for one frame).

SHOT TYPES: extreme wide shot, wide shot, medium shot, medium close-up, close-up, extreme close-up, over the shoulder, two-shot, point of view

CAMERA MOVEMENTS: static, pan left/right, tilt up/down, dolly in/out, crane up/down, tracking shot, handheld, zoom in/out

OUTPUT FORMAT (JSON array):
[
  {
    "panelIndex": 0,
    "description": "Detailed visual description of what is shown in this panel",
    "characters": ["character names in this shot"],
    "location": "specific location",
    "shotType": "shot type",
    "cameraMovement": "camera movement description",
    "mood": "emotional tone of the panel",
    "action": "what is happening / characters' actions",
    "dialogue": "any dialogue or narration in this panel (empty string if none)",
    "imagePrompt": "Detailed English image generation prompt: style, composition, lighting, characters, setting...",
    "videoPrompt": "Brief video motion description for this panel"
  }
]"""


def generate_storyboard_skill(
    clip: dict,
    characters: list,
    locations: list,
    art_style: str = 'cinematic realistic',
    language: str = 'zh',
    ai_settings: dict[str, Any] | None = None,
) -> list:
    """
    为情节片段生成分镜面板列表
    """
    settings = ai_settings or get_default_ai_settings()

    clip_chars = set(clip.get('characters', []))
    char_ctx = '\n'.join(
        f"- {c['name']}\n"
        f"  Base appearance (fixed, never change across scenes): {c.get('imagePrompt') or c.get('description', '')}\n"
        f"  Scene context: {c.get('description', '')}"
        for c in characters
        if c['name'] in clip_chars
    ) or 'No specific character info'

    loc_info = next((l for l in locations if l['name'] == clip.get('location')), None)
    loc_ctx = f"{loc_info['name']}: {loc_info['description']}" if loc_info else clip.get('location', 'Unknown')

    user_prompt = f"""Art Style: {art_style}

Location: {loc_ctx}

Characters in this scene:
{char_ctx}

Scene Summary: {clip.get('summary', '')}

Scene Content:
{clip.get('content', '')}

Generate storyboard panels for this scene. Image prompts must be in English and include the art style "{art_style}"."""

    text_content = chat_completion_text(
        system_prompt=_SYSTEM_PROMPT,
        user_prompt=user_prompt,
        ai_settings=settings,
        max_tokens=4096,
        temperature=0.3,
    )

    panels = safe_parse_json(text_content)

    if isinstance(panels, dict):
        panels = panels.get('panels', [])
    return panels if isinstance(panels, list) else []
