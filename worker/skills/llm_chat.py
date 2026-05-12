"""OpenAI 兼容 Chat Completions — 支持任意 provider（base URL + API Key + model）"""

from __future__ import annotations

from typing import Any


def chat_completion_text(
    *,
    system_prompt: str,
    user_prompt: str,
    ai_settings: dict[str, Any],
    max_tokens: int = 8192,
    temperature: float = 0.25,
) -> str:
    llm = ai_settings['llm']
    api_key = (llm.get('apiKey') or '').strip()
    if not api_key:
        raise ValueError(
            '未配置文本模型 API Key：请在「AI 设置」中填写 LLM API Key，或设置环境变量 LLM_API_KEY'
        )

    base_url = (llm.get('baseUrl') or '').strip().rstrip('/') or 'https://api.openai.com/v1'
    model = (llm.get('model') or 'gpt-4o-mini').strip()

    from openai import OpenAI

    client = OpenAI(api_key=api_key, base_url=base_url)
    resp = client.chat.completions.create(
        model=model,
        messages=[
            {'role': 'system', 'content': system_prompt},
            {'role': 'user', 'content': user_prompt},
        ],
        max_tokens=max_tokens,
        temperature=temperature,
    )
    choice = resp.choices[0].message.content
    return (choice or '').strip()
