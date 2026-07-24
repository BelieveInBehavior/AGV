/**
 * 为项目资产库生成单张角色/场景参考图（支持 FAL / OpenAI 兼容图片接口）
 */
import * as fal from '@fal-ai/client';
import {
  CHARACTER_REFERENCE_RATIO,
  getResolutionFromRatio,
} from '../skills/build-image-prompt.js';

function pickOpenAiImageSize(width, height) {
  if (width > height) return '1536x1024';
  if (height > width) return '1024x1536';
  return '1024x1024';
}

async function postOpenAiImage({ baseUrl, apiKey, path, body }) {
  const root = String(baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  const res = await fetch(`${root}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${String(apiKey || '').trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    const message = data?.error?.message || data?.message || `HTTP ${res.status}`;
    throw new Error(`图片接口调用失败: ${message}`);
  }
  return data;
}

function extractOpenAiImage(data, outputFormat = 'jpeg') {
  const item = Array.isArray(data?.data) ? data.data[0] : null;
  if (!item) return null;
  if (item.url) return item.url;
  if (item.b64_json) {
    const mime = outputFormat === 'png' ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${item.b64_json}`;
  }
  return null;
}

/**
 * @param {{
 *   provider?: 'fal'|'openai',
 *   baseUrl?: string,
 *   apiKey: string,
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
  provider = 'fal',
  baseUrl,
  apiKey,
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

  const styleBit = `Art direction: ${artStyle || 'cinematic'}.`;

  let prompt;
  if (imagePrompt && imagePrompt.trim()) {
    const base = imagePrompt.trim();
    prompt =
      kind === 'character'
        ? `${styleBit} Vertical 9:16 portrait, full body character reference sheet, neutral pose, clear face, simple studio background. ${base}`
        : `${styleBit} ${base}`;
  } else {
    prompt =
      kind === 'character'
        ? `${styleBit} Vertical 9:16 portrait, full body character reference sheet, neutral pose, clear face, simple studio background, single character named ${name}. ${description || ''}`
        : `${styleBit} Wide environment concept art, establishing shot, no people, empty scene: ${name}. ${description || ''}`;
  }

  if (provider === 'openai') {
    const result = await postOpenAiImage({
      baseUrl,
      apiKey,
      path: '/images/generations',
      body: {
        model: modelId,
        prompt: `${prompt}\n\nAvoid: blurry, low quality, deformed, watermark, signature, text, multiple characters, crowd`,
        size: pickOpenAiImageSize(width, height),
        quality: 'medium',
        output_format: 'jpeg',
        output_compression: 90,
      },
    });
    return extractOpenAiImage(result, 'jpeg');
  }

  fal.config({ credentials: apiKey });
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
