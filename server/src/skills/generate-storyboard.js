/**
 * Skill: 分镜生成
 *
 * 纯 LLM 函数 — OpenAI 兼容 API（与 Worker 对齐）
 */

import config from '../config/index.js';
import { safeParseJson } from '../utils/json-utils.js';
import { chatCompletionText } from '../utils/llm-openai-compat.js';

const SYSTEM_PROMPT = `You are a professional film director and storyboard artist.
Your task is to break down a story clip into detailed visual storyboard panels.

RULES:
1. Create 3-6 panels per clip (more for action/complex scenes)
2. Each panel is a single camera shot — one moment in time
3. Include specific shot types and camera movements
4. Think cinematically — vary angles, distances, compositions
5. Always respond with valid JSON only

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
    "dialogue": "any dialogue or narration in this panel (if any)",
    "imagePrompt": "Detailed English image generation prompt: style, composition, lighting, characters, setting...",
    "videoPrompt": "Brief video motion description for this panel"
  }
]`;

/**
 * @param {{
 *   clip: object,
 *   characters: Array<{ name: string, description: string }>,
 *   locations: Array<{ name: string, description: string }>,
 *   artStyle?: string,
 *   language?: 'zh'|'en'
 * }} params
 */
export async function generateStoryboardSkill({
  clip,
  characters = [],
  locations = [],
  artStyle = 'cinematic realistic',
  language = 'zh',
}) {
  const characterContext =
    characters
      .filter((c) => clip.characters?.includes(c.name))
      .map((c) => `- ${c.name}: ${c.description}`)
      .join('\n') || 'No specific character info';

  const locationInfo = locations.find((l) => l.name === clip.location);
  const locationContext = locationInfo
    ? `${locationInfo.name}: ${locationInfo.description}`
    : clip.location || 'Unknown location';

  const userPrompt = `Art Style: ${artStyle}

Location: ${locationContext}

Characters in this scene:
${characterContext}

Scene Summary: ${clip.summary}

Scene Content:
${clip.content}

Generate storyboard panels for this scene. Image prompts must be in English and include the art style "${artStyle}".`;

  const textContent = await chatCompletionText({
    system: SYSTEM_PROMPT,
    user: userPrompt,
    baseUrl: config.llm.baseUrl,
    apiKey: config.llm.apiKey,
    model: config.llm.model,
    maxTokens: 4096,
    temperature: 0.3,
  });

  const panels = safeParseJson(textContent);

  return Array.isArray(panels) ? panels : panels.panels || [];
}
