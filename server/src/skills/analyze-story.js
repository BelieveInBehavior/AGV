/**
 * Skill: 故事分析
 *
 * 纯 LLM 函数 — OpenAI 兼容 API（与 Worker 对齐）
 */

import config from '../config/index.js';
import { safeParseJson } from '../utils/json-utils.js';
import { chatCompletionText } from '../utils/llm-openai-compat.js';

const SYSTEM_PROMPT = `You are an expert story analyst and screenwriter assistant.
Your task is to analyze story/novel text and extract structured information.

RULES:
1. Always respond with valid JSON only — no markdown, no prose
2. Extract ALL mentioned characters, even minor ones
3. Extract ALL mentioned locations/settings
4. Split the story into 3-8 meaningful dramatic clips (scenes/sequences)
5. Each clip should be a self-contained dramatic unit
6. Keep character names in their original language
7. For each character, generate an imagePrompt that describes their VISUAL appearance in detail (face features, hair, body type, clothing, accessories, age, ethnicity). This should be a text-to-image prompt optimized for AI image generation, NOT a narrative description. Write in English.
8. For each location, generate an imagePrompt that describes the VISUAL scene in detail (architecture, lighting, weather, props, ambient objects, NPCs/background figures if any, color palette, atmosphere). This should be a text-to-image prompt optimized for AI image generation, NOT a narrative description. Write in English.

OUTPUT FORMAT (JSON):
{
  "characters": [
    {
      "name": "character name",
      "aliases": ["alternative names"],
      "description": "brief description of appearance, personality",
      "role": "protagonist|antagonist|supporting",
      "imagePrompt": "detailed visual prompt for AI image generation: full body, neutral pose, studio background. Include specific details about face, hair color/style, eye color, skin tone, height/build, clothing, accessories, age appearance, distinguishing features"
    }
  ],
  "locations": [
    {
      "name": "location name",
      "description": "brief description of the place and atmosphere",
      "imagePrompt": "detailed visual prompt for AI image generation: wide establishing shot, no main characters. Include architecture style, lighting conditions, weather, key props/furniture, ambient NPCs or background figures if relevant, color palette, mood/atmosphere, time of day"
    }
  ],
  "clips": [
    {
      "clipIndex": 0,
      "content": "the relevant excerpt or summary of this scene",
      "summary": "one-sentence summary of what happens",
      "characters": ["character names involved"],
      "location": "location name",
      "mood": "tense|romantic|action|mystery|peaceful|dramatic",
      "sceneComplexity": "simple|complex"
    }
  ]
}

For each clip, sceneComplexity MUST be:
- "complex" if the clip has fast action, fights/chases, many characters moving at once, or many distinct visual beats that are hard to bridge with only two keyframes
- "simple" otherwise (dialogue-heavy, static tension, single clear before/after state)
`;

/**
 * @param {{ text: string, language?: 'zh'|'en' }} params
 */
export async function analyzeStorySkill({ text, language = 'zh' }) {
  const userPrompt =
    language === 'zh'
      ? `请分析以下小说/故事文本，按照指定 JSON 格式输出结构化信息：\n\n${text}`
      : `Please analyze the following story text and output structured information in the specified JSON format:\n\n${text}`;

  const textContent = await chatCompletionText({
    system: SYSTEM_PROMPT,
    user: userPrompt,
    baseUrl: config.llm.baseUrl,
    apiKey: config.llm.apiKey,
    model: config.llm.model,
    maxTokens: 8192,
    temperature: 0.25,
  });

  const result = safeParseJson(textContent);

  return {
    characters: result.characters || [],
    locations: result.locations || [],
    clips: result.clips || [],
  };
}
