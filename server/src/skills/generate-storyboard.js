/**
 * Skill: 分镜生成
 *
 * 纯 LLM 函数 — OpenAI 兼容 API（与 Worker 对齐）
 * Prompt 风格对齐 waoowaoo agent_storyboard_plan（中文）
 */

import config from '../config/index.js';
import { safeParseJson } from '../utils/json-utils.js';
import { chatCompletionText } from '../utils/llm-openai-compat.js';

const SYSTEM_PROMPT = `你是专业的分镜规划师。将一段情节拆成 3–6 个电影镜头（动作/复杂场景可更多）。

【核心原则 — 对齐 waoowaoo】
1. 精准覆盖关键画面：建立镜头、核心动作、重要对话、情绪转折点
2. 电影思维：每个 panel 是单一时间点的单一机位
3. 对话镜头：说话者需有聚焦脸部的独立镜头；禁止一镜两人同时说话
4. 角色名必须用资产库全名，禁止「母亲」「老板」等称呼代替
5. 只返回 JSON 数组，禁止 markdown

【角色外貌一致性】
characters 条目中每个角色有「基础形象 imagePrompt」— 为固定五官/发型/肤色/体型。写 imagePrompt 时必须完整保留基础形象，仅叠加本镜服装/表情/动作。

【imagePrompt 质量守则 G1–G4】
G1. 景别一致：特写不写全身姿态；中景不写脚；全景不写毛孔细节
G2. 液体局部化：泪汗血写在具体部位
G3. 姿势简化：避免复杂跪姿，用环境暗示
G4. 单一视觉焦点

【景别 shotType】
大远景、远景、中景、中近景、近景、特写、过肩镜头、双人镜头、主观镜头

【运镜 cameraMovement】
固定、左摇、右摇、上摇、下摇、推轨、拉轨、升降、跟拍、手持、变焦

【输出 JSON 数组】
[
  {
    "panelIndex": 0,
    "description": "中文画面描述：人物动作、构图、环境",
    "characters": ["角色名"],
    "location": "场景名",
    "shotType": "景别",
    "cameraMovement": "运镜",
    "mood": "情绪基调",
    "action": "正在发生什么",
    "dialogue": "本镜台词或旁白，无则空字符串",
    "imagePrompt": "中文 AI 生图提示词：含画风、构图、光线、角色基础形象+本镜状态，遵守 G1–G4",
    "videoPrompt": "中文视频动态描述；说话镜头须写「正在说话」；用年龄段+性别指代角色（如年轻女子、中年男子），勿用角色名"
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
      .map(
        (c) =>
          `- ${c.name}\n  基础形象：${c.imagePrompt || c.description || ''}\n  角色介绍：${c.introduction || c.description || ''}`,
      )
      .join('\n') || '（无角色档案）';

  const locationInfo = locations.find((l) => l.name === clip.location);
  const locationContext = locationInfo
    ? `${locationInfo.name}：${locationInfo.description}`
    : clip.location || '未知场景';

  const userPrompt = `画风：${artStyle}

【场景】${locationContext}

【出场角色】
${characterContext}

【情节摘要】${clip.summary}

【情节正文】
${clip.content}

请生成分镜 JSON 数组。每条 imagePrompt、videoPrompt 均为中文，imagePrompt 须体现画风「${artStyle}」。`;

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
