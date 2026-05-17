"""
多参考图生图 Skill：按 provider 分派；不支持多参考时退化为首张参考的 i2i。

beat 首尾帧 / 角色状态图 / 分镜 均可复用；当前 FAL 分支完整实现，gemini/doubao 预留为单参考降级。
"""

from __future__ import annotations

import os
from typing import Any

import config

from skills.build_image_prompt import ART_STYLE_KEYWORDS


def _fal_subscribe(model_id: str, arguments: dict, fal_key: str):
    import fal_client

    prev = os.environ.get('FAL_KEY')
    os.environ['FAL_KEY'] = fal_key
    try:
        return fal_client.subscribe(model_id, arguments=arguments)
    finally:
        if prev is None:
            os.environ.pop('FAL_KEY', None)
        else:
            os.environ['FAL_KEY'] = prev


def _fal_generate(
    *,
    positive: str,
    negative: str,
    width: int,
    height: int,
    model_id: str,
    fal_key: str,
    reference_urls: list[str],
    use_first_reference_only: bool,
) -> str | None:
    """reference_urls 顺序：场景 / 角色状态 / …；仅首张参与 i2i 时与旧逻辑一致。"""
    ref = [u for u in reference_urls if isinstance(u, str) and u.strip()]
    i2i_model = (config.FAL_IMAGE_I2I_MODEL or '').strip() or 'fal-ai/flux/dev/image-to-image'

    if ref and use_first_reference_only:
        prompt = (
            f'{positive}, maintain subjects, wardrobe, and environment '
            f'consistent with the reference image'
        )
        arguments: dict = {
            'prompt': prompt,
            'image_url': ref[0],
            'strength': 0.62,
            'image_size': {'width': width, 'height': height},
            'num_inference_steps': 28,
            'guidance_scale': 3.5,
        }
        try:
            result = _fal_subscribe(i2i_model, arguments, fal_key)
        except Exception:
            result = _fal_subscribe(
                model_id,
                arguments={
                    'prompt': positive,
                    'negative_prompt': negative,
                    'image_size': {'width': width, 'height': height},
                    'num_inference_steps': 4,
                    'num_images': 1,
                },
                fal_key=fal_key,
            )
    elif ref:
        # 多参考：当前仅首张接入 FAL i2i；其余信息应已融入 positive
        return _fal_generate(
            positive=positive,
            negative=negative,
            width=width,
            height=height,
            model_id=model_id,
            fal_key=fal_key,
            reference_urls=ref,
            use_first_reference_only=True,
        )
    else:
        result = _fal_subscribe(
            model_id,
            arguments={
                'prompt': positive,
                'negative_prompt': negative,
                'image_size': {'width': width, 'height': height},
                'num_inference_steps': 4,
                'num_images': 1,
            },
            fal_key=fal_key,
        )

    images = result.get('images', [])
    return images[0]['url'] if images else None


def multi_ref_image_gen(
    *,
    provider_cfg: dict[str, Any],
    scene_prompt: str,
    reference_urls: list[str],
    width: int,
    height: int,
    art_style: str,
    prompt_suffix: str = '',
    single_ref_extra_hint: str = '',
) -> str | None:
    """
    Args:
        scene_prompt: 英文镜头/场景/动作/光线（不含人物外貌）
        reference_urls: 场景 ref 在前，其后为各角色状态 ref
        single_ref_extra_hint: 单参考退化时追加的英文提示（如衣着情绪）
        prompt_suffix: 与 panels 一致的文本一致性摘要
    """
    style_key = (art_style or 'cinematic').lower()
    style_kw = ART_STYLE_KEYWORDS.get(style_key, ART_STYLE_KEYWORDS['cinematic'])
    parts = [scene_prompt.strip(), style_kw, 'high quality, detailed, professional composition']
    if prompt_suffix and str(prompt_suffix).strip():
        parts.append(str(prompt_suffix).strip())
    hint = (single_ref_extra_hint or '').strip()
    if hint:
        parts.append(hint)
    positive = ', '.join(p for p in parts if p)
    negative = (
        'blurry, low quality, distorted, deformed, ugly, bad anatomy, '
        'text, watermark, signature, oversaturated, poorly drawn'
    )

    prov = (provider_cfg.get('provider') or 'fal').lower()
    supports_multi = bool(provider_cfg.get('supportsMultiReference'))
    fal_key = (provider_cfg.get('apiKey') or config.FAL_API_KEY or '').strip()
    model_id = (provider_cfg.get('model') or '').strip() or config.FAL_IMAGE_MODEL

    if prov in ('none', ''):
        import urllib.parse

        text = urllib.parse.quote((scene_prompt or 'Keyframe')[:30])
        return f'https://placehold.co/{width}x{height}/1a1f35/ffffff?text={text}'

    if prov == 'fal' and fal_key:
        return _fal_generate(
            positive=positive,
            negative=negative,
            width=width,
            height=height,
            model_id=model_id,
            fal_key=fal_key,
            reference_urls=reference_urls,
            use_first_reference_only=not supports_multi,
        )

    # gemini / doubao：骨架 — 退化为无 Key 占位或未来的多模态 API
    if prov in ('gemini', 'doubao'):
        # TODO: 接入官方多参考生图 API
        if fal_key:
            return _fal_generate(
                positive=positive,
                negative=negative,
                width=width,
                height=height,
                model_id=model_id,
                fal_key=fal_key,
                reference_urls=reference_urls,
                use_first_reference_only=True,
            )
        import urllib.parse

        text = urllib.parse.quote(f'{prov}-{scene_prompt[:20]}')
        return f'https://placehold.co/{width}x{height}/1a1f35/ffffff?text={text}'

    if fal_key:
        return _fal_generate(
            positive=positive,
            negative=negative,
            width=width,
            height=height,
            model_id=model_id,
            fal_key=fal_key,
            reference_urls=reference_urls,
            use_first_reference_only=True,
        )

    import urllib.parse

    text = urllib.parse.quote((scene_prompt or 'Keyframe')[:30])
    return f'https://placehold.co/{width}x{height}/1a1f35/ffffff?text={text}'
