/**
 * 为项目资产库生成单张角色/场景参考图（FAL 文生图）
 */
import * as fal from '@fal-ai/client';
import {
  CHARACTER_REFERENCE_RATIO,
  getResolutionFromRatio,
} from '../skills/build-image-prompt.js';

/**
 * @param {{
 *   falKey: string,
 *   modelId: string,
 *   artStyle: string,
 *   videoRatio: string,
 *   kind: 'character' | 'location',
 *   name: string,
 *   description: string,
 *   imagePrompt?: string,
 * }} params
 * @returns {Promise<string|null>}
 */
export async function generateLibraryReferenceImage({
  falKey,
  modelId,
  artStyle,
  videoRatio,
  kind,
  name,
  description,
  imagePrompt,
}) {
  const ratio =
    kind === 'character' ? CHARACTER_REFERENCE_RATIO : videoRatio || '16:9';
  const { width, height } = getResolutionFromRatio(ratio);

  fal.config({ credentials: falKey });
  const styleBit = `Art direction: ${artStyle || 'cinematic'}.`;

  let prompt;
  if (imagePrompt && imagePrompt.trim()) {
    // 使用 LLM 从故事文本中解析出的专用 imagePrompt
    const base = imagePrompt.trim();
    prompt =
      kind === 'character'
        ? `${styleBit} Vertical 9:16 portrait, full body character reference sheet, neutral pose, clear face, simple studio background. ${base}`
        : `${styleBit} ${base}`;
  } else {
    // 兜底：使用 description 拼接通用模板
    prompt =
      kind === 'character'
        ? `${styleBit} Vertical 9:16 portrait, full body character reference sheet, neutral pose, clear face, simple studio background, single character named ${name}. ${description || ''}`
        : `${styleBit} Wide environment concept art, establishing shot, no people, empty scene: ${name}. ${description || ''}`;
  }

  const result = await fal.subscribe(modelId, {
    input: {
      prompt,
      negative_prompt:
        'blurry, low quality, deformed, watermark, signature, text, multiple characters, crowd',
      image_size: { width, height },
      num_inference_steps: 4,
      num_images: 1,
    },
  });

  return result?.data?.images?.[0]?.url || result?.images?.[0]?.url || null;
}
