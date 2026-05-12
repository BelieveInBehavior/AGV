"""
Skill: 故事分析 (Python)

纯函数 — 无 DB 副作用
输入文本 → OpenAI 兼容 API → 结构化角色/场景/情节片段
"""

from typing import Any

from skills.llm_chat import chat_completion_text
from utils.ai_settings import get_default_ai_settings
from utils.json_utils import safe_parse_json

_SYSTEM_PROMPT = """You are an expert story analyst and screenwriter assistant.
Your task is to analyze story/novel text and extract structured information.

RULES:
1. Always respond with valid JSON only — no markdown, no prose
2. Extract ALL mentioned characters, even minor ones
3. Extract ALL mentioned locations/settings
4. Split the story into 3-8 meaningful dramatic clips (scenes/sequences)
5. Each clip should be a self-contained dramatic unit
6. Keep character names in their original language

OUTPUT FORMAT (JSON):
{
  "characters": [
    {
      "name": "character name",
      "aliases": ["alternative names"],
      "description": "brief description of appearance, personality",
      "role": "protagonist|antagonist|supporting"
    }
  ],
  "locations": [
    {
      "name": "location name",
      "description": "brief description of the place and atmosphere"
    }
  ],
  "clips": [
    {
      "clipIndex": 0,
      "content": "the relevant excerpt or summary of this scene",
      "summary": "one-sentence summary of what happens",
      "characters": ["character names involved"],
      "location": "location name",
      "mood": "tense|romantic|action|mystery|peaceful|dramatic"
    }
  ]
}"""


def analyze_story_skill(
    text: str,
    language: str = 'zh',
    ai_settings: dict[str, Any] | None = None,
) -> dict:
    """
    分析故事文本，返回结构化数据

    Args:
        text: 小说/故事正文
        language: 'zh' 或 'en'
        ai_settings: 来自 get_ai_settings_for_project / get_default_ai_settings
    """
    settings = ai_settings or get_default_ai_settings()

    user_prompt = (
        f'请分析以下小说/故事文本，按照指定 JSON 格式输出结构化信息：\n\n{text}'
        if language == 'zh'
        else f'Please analyze the following story text and output structured information in the specified JSON format:\n\n{text}'
    )

    text_content = chat_completion_text(
        system_prompt=_SYSTEM_PROMPT,
        user_prompt=user_prompt,
        ai_settings=settings,
        max_tokens=8192,
        temperature=0.25,
    )

    result = safe_parse_json(text_content)
    return {
        'characters': result.get('characters', []),
        'locations': result.get('locations', []),
        'clips': result.get('clips', []),
    }
