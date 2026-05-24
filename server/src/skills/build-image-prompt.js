/**
 * Skill: 图像提示词构建
 *
 * 纯函数 — 不调用 LLM，基于规则构建优化的图像生成提示词
 * 可被多个 Agent 复用
 *
 * 使用:
 *   import { buildImagePromptSkill } from '../skills/build-image-prompt.js'
 *   const prompt = buildImagePromptSkill({ panel, artStyle, aspectRatio })
 */

/** 艺术风格到关键词的映射 */
const ART_STYLE_KEYWORDS = {
  'realistic': 'photorealistic, 8k, high detail, professional photography',
  'cinematic': 'cinematic, film still, movie quality, dramatic lighting, anamorphic lens',
  'anime': 'anime style, detailed illustration, vibrant colors, clean linework, manga-inspired',
  'american-comic': 'comic book style, bold lines, dynamic poses, halftone, superhero aesthetic',
  'watercolor': 'watercolor painting, soft edges, flowing colors, artistic, expressive brushwork',
  'oil-painting': 'oil painting, classical style, rich textures, museum quality, old masters',
  '3d-render': '3D render, CGI, octane render, ray tracing, photorealistic materials',
  'sketch': 'pencil sketch, detailed linework, black and white, artistic illustration',
};

/** 镜头类型到技术关键词的映射 */
const SHOT_TYPE_KEYWORDS = {
  'extreme wide shot': 'extreme wide angle, establishing shot, vast landscape',
  'wide shot': 'wide angle, full body, environmental context',
  'medium shot': 'medium shot, waist up, balanced composition',
  'medium close-up': 'medium close-up, chest up, intimate framing',
  'close-up': 'close-up shot, face focused, detailed expression',
  'extreme close-up': 'extreme close-up, macro detail, intense focus',
  'over the shoulder': 'over-the-shoulder shot, two characters, depth',
  'two-shot': 'two-shot, both characters visible, interaction',
  'point of view': 'POV shot, first-person perspective, immersive',
};

/**
 * 构建优化的图像生成提示词
 * @param {{
 *   panel: {
 *     description: string,
 *     imagePrompt?: string,
 *     characters?: string[],
 *     location?: string,
 *     shotType?: string,
 *     mood?: string,
 *     action?: string
 *   },
 *   artStyle?: string,
 *   aspectRatio?: string,
 *   negativePrompt?: boolean
 * }} params
 * @returns {{ positive: string, negative: string }}
 */
export function buildImagePromptSkill({
  panel,
  artStyle = 'cinematic',
  aspectRatio = '16:9',
  negativePrompt = true,
}) {
  const parts = [];

  // 1. 如果 panel 已有 imagePrompt，直接使用并增强
  if (panel.imagePrompt) {
    parts.push(panel.imagePrompt);
  } else {
    // 从 description 构建
    parts.push(panel.description);
    if (panel.action) parts.push(panel.action);
    if (panel.location) parts.push(`setting: ${panel.location}`);
  }

  // 2. 艺术风格
  const styleKeywords = ART_STYLE_KEYWORDS[artStyle] || ART_STYLE_KEYWORDS['cinematic'];
  parts.push(styleKeywords);

  // 3. 镜头技术
  if (panel.shotType) {
    const shotKeywords = SHOT_TYPE_KEYWORDS[panel.shotType.toLowerCase()];
    if (shotKeywords) parts.push(shotKeywords);
  }

  // 4. 情绪/氛围
  if (panel.mood) {
    parts.push(`${panel.mood} mood, ${panel.mood} atmosphere`);
  }

  // 5. 通用质量关键词
  parts.push('high quality, detailed, professional composition');

  const positive = parts.filter(Boolean).join(', ');

  const negative = negativePrompt
    ? 'blurry, low quality, distorted, deformed, ugly, bad anatomy, text, watermark, signature, oversaturated, poorly drawn'
    : '';

  return { positive, negative };
}

/** 角色形象参考图固定竖屏比例（与项目 videoRatio 无关） */
export const CHARACTER_REFERENCE_RATIO = '9:16';

/**
 * 获取宽高比对应的分辨率
 * @param {string} ratio - '16:9', '9:16', '1:1', '4:3', '3:4'
 * @returns {{ width: number, height: number }}
 */
export function getResolutionFromRatio(ratio) {
  const resolutions = {
    '16:9': { width: 1280, height: 720 },
    '9:16': { width: 720, height: 1280 },
    '1:1': { width: 1024, height: 1024 },
    '4:3': { width: 1024, height: 768 },
    '3:4': { width: 768, height: 1024 },
    '21:9': { width: 1920, height: 820 },
  };
  return resolutions[ratio] || resolutions['16:9'];
}
