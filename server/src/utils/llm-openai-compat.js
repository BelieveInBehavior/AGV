/**
 * OpenAI 兼容 Chat Completions（与 Worker `skills/llm_chat.py` 对齐）
 */
import OpenAI from 'openai';

/**
 * @param {{ system: string, user: string, baseUrl?: string, apiKey: string, model: string, maxTokens?: number }} p
 */
export async function chatCompletionText({
  system,
  user,
  baseUrl,
  apiKey,
  model,
  maxTokens = 8192,
  temperature = 0.25,
}) {
  if (!apiKey?.trim()) {
    throw new Error('未配置 LLM API Key（LLM_API_KEY 或设置页）');
  }

  const client = new OpenAI({
    apiKey: apiKey.trim(),
    baseURL: baseUrl?.trim() || undefined,
  });

  const completion = await client.chat.completions.create({
    model: model.trim(),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens,
    temperature,
  });

  return completion.choices[0]?.message?.content?.trim() ?? '';
}
