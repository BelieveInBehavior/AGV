"""
多参考图生图 Skill：目前仅支持 OpenAI/OpenRouter 兼容接口。

beat 首尾帧 / 角色状态图 / 分镜 均可复用。
"""

from __future__ import annotations

from typing import Any

import config

from skills.build_image_prompt import ART_STYLE_KEYWORDS


def _pick_openai_image_size(width: int, height: int) -> str:
    """OpenAI 图片接口支持的固定尺寸。"""
    if width > height:
        return '1536x1024'
    if height > width:
        return '1024x1536'
    return '1024x1024'


def _openai_post_json(
    *,
    base_url: str,
    api_key: str,
    path: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    import httpx

    root = (base_url or config.IMAGE_BASE_URL or config.LLM_BASE_URL or 'https://api.openai.com/v1').strip().rstrip('/')
    configured_timeout = float(getattr(config, 'IMAGE_REQUEST_TIMEOUT_SECONDS', 60) or 60)
    is_openrouter = 'openrouter' in root.lower()
    # OpenRouter 图片生成经常明显慢于普通聊天请求，60s 容易误判为失败
    timeout_seconds = max(5.0, configured_timeout, 180.0 if is_openrouter else 60.0)
    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
    }
    url = f'{root}{path}'
    print(f'[DEBUG] POST {url}')
    print(f'[DEBUG] payload: {payload}')
    timeout = httpx.Timeout(connect=min(timeout_seconds, 15.0), read=timeout_seconds, write=30.0, pool=15.0)
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(url, headers=headers, json=payload)
    except httpx.TimeoutException as exc:
        raise RuntimeError(
            f'OpenAI 图片接口调用超时: provider={root}, timeout={int(timeout_seconds)}s'
        ) from exc
    except httpx.HTTPError as exc:
        raise RuntimeError(f'OpenAI 图片接口网络错误: provider={root}, detail={exc!s}') from exc
    print(f'[DEBUG] response status: {resp.status_code}')
    if resp.status_code >= 400:
        try:
            body = resp.json()
        except Exception:
            body = {}
        message = (
            body.get('error', {}).get('message')
            or body.get('message')
            or resp.text
            or f'HTTP {resp.status_code}'
        )
        print(f'[DEBUG] error response: {resp.text}')
        raise RuntimeError(f'OpenAI 图片接口调用失败: {message}')
    return resp.json()


def _extract_openai_image_result(result: dict[str, Any], output_format: str) -> str | None:
    items = result.get('data') or []
    if not items:
        return None
    first = items[0] or {}
    url = first.get('url') or first.get('image_url')
    if isinstance(url, str) and url.strip():
        return url.strip()
    b64 = first.get('b64_json') or first.get('base64')
    if isinstance(b64, str) and b64.strip():
        fmt = (output_format or 'png').lower()
        mime = 'image/jpeg' if fmt in ('jpg', 'jpeg') else f'image/{fmt}'
        return f'data:{mime};base64,{b64.strip()}'
    return None


def _openai_generate(
    *,
    positive: str,
    negative: str,
    width: int,
    height: int,
    model_id: str,
    api_key: str,
    base_url: str,
    reference_urls: list[str],
) -> str | None:
    """生成图片，支持参考图。OpenRouter 和官方 OpenAI 参数格式不同。"""
    ref = [u for u in reference_urls if isinstance(u, str) and u.strip()]
    output_format = 'jpeg'
    prompt = positive.strip()
    if negative.strip():
        prompt = f'{prompt}\n\nAvoid: {negative.strip()}'

    is_openrouter = 'openrouter' in base_url.lower()

    payload: dict[str, Any] = {
        'model': model_id,
        'prompt': prompt,
        'n': 1,
    }

    # OpenRouter 和官方 OpenAI 的尺寸参数不同
    if is_openrouter:
        payload['size'] = _pick_openai_image_size(width, height)
    else:
        payload['size'] = _pick_openai_image_size(width, height)
        payload['quality'] = 'medium'
        payload['output_format'] = output_format
        payload['output_compression'] = 90

    # 参考图处理
    if ref:
        if is_openrouter:
            # OpenRouter: 参考图用 input_references 数组，需要 type 字段
            # 仅保留 HTTP(S) URL，过滤掉 data: URL（OpenRouter 可能不支持）
            http_refs = [u for u in ref if u.startswith('http://') or u.startswith('https://')]
            if http_refs:
                payload['input_references'] = [
                    {'type': 'image_url', 'image_url': {'url': u}}
                    for u in http_refs
                ]
            # 如果只有 data: URL，融入 prompt
            if not http_refs and ref:
                prompt = f'{prompt}\n\nUse provided reference image styles for consistency.'
                payload['prompt'] = prompt
        else:
            # 官方 OpenAI：暂不支持 image_url，只能融入 prompt
            # （真正的图片输入需要用 vision API 或其他模型）
            if len(ref) > 0:
                ref_hint = 'Reference image for consistency: ' + ', '.join(ref[:3])
                prompt = f'{prompt}\n\n{ref_hint}'
                payload['prompt'] = prompt

    path = '/images/generations' if not is_openrouter else '/images/generations'
    result = _openai_post_json(
        base_url=base_url,
        api_key=api_key,
        path=path,
        payload=payload,
    )
    return _extract_openai_image_result(result, output_format)


def generate_image_with_provider(
    *,
    provider_cfg: dict[str, Any],
    positive: str,
    negative: str,
    width: int,
    height: int,
    reference_urls: list[str] | None = None,
) -> str | None:
    prov = (provider_cfg.get('provider') or 'none').lower()
    base_url = str(
        provider_cfg.get('baseUrl')
        or config.IMAGE_BASE_URL
        or config.LLM_BASE_URL
        or 'https://api.openai.com/v1'
    ).strip().rstrip('/')
    model_id = (provider_cfg.get('model') or config.IMAGE_MODEL or 'gpt-image-1').strip()
    force_multi_openai = prov == 'openai' and (
        'openrouter.ai' in base_url.lower()
        or model_id.startswith('openai/')
        or model_id.startswith('gpt-image')
    )
    supports_multi = bool(provider_cfg.get('supportsMultiReference')) or force_multi_openai
    max_reference_images = max(
        1,
        int(provider_cfg.get('maxReferenceImages') or (16 if force_multi_openai else 1)),
    )
    refs = [u for u in (reference_urls or []) if isinstance(u, str) and u.strip()]
    if refs:
        refs = refs[: max_reference_images if supports_multi else 1]

    if prov in ('none', ''):
        import urllib.parse

        text = urllib.parse.quote((positive or 'Keyframe')[:30])
        return f'https://placehold.co/{width}x{height}/1a1f35/ffffff?text={text}'

    if prov == 'openai':
        api_key = (provider_cfg.get('apiKey') or config.IMAGE_API_KEY or '').strip()
        if not api_key:
            raise ValueError('未配置 OpenAI 图片 API Key')
        return _openai_generate(
            positive=positive,
            negative=negative,
            width=width,
            height=height,
            model_id=model_id,
            api_key=api_key,
            base_url=str(base_url).strip().rstrip('/'),
            reference_urls=refs,
        )

    import urllib.parse

    text = urllib.parse.quote((positive or 'Keyframe')[:30])
    return f'https://placehold.co/{width}x{height}/1a1f35/ffffff?text={text}'


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
    return generate_image_with_provider(
        provider_cfg=provider_cfg,
        positive=positive,
        negative=negative,
        width=width,
        height=height,
        reference_urls=reference_urls,
    )
