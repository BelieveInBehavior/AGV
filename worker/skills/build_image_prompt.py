"""
Skill: 图像提示词构建 (Python)

纯函数 — 不调用 LLM，基于规则
与 JS 版本 build-image-prompt.js 完全等价
"""

ART_STYLE_KEYWORDS = {
    'realistic':       'photorealistic, 8k, high detail, professional photography',
    'cinematic':       'cinematic, film still, movie quality, dramatic lighting, anamorphic lens',
    'anime':           'anime style, detailed illustration, vibrant colors, clean linework',
    'american-comic':  'comic book style, bold lines, dynamic poses, halftone, superhero',
    'watercolor':      'watercolor painting, soft edges, flowing colors, artistic brushwork',
    'oil-painting':    'oil painting, classical style, rich textures, museum quality',
    '3d-render':       '3D render, CGI, octane render, ray tracing, photorealistic materials',
    'sketch':          'pencil sketch, detailed linework, black and white, artistic illustration',
}

SHOT_TYPE_KEYWORDS = {
    'extreme wide shot':  'extreme wide angle, establishing shot, vast landscape',
    'wide shot':          'wide angle, full body, environmental context',
    'medium shot':        'medium shot, waist up, balanced composition',
    'medium close-up':    'medium close-up, chest up, intimate framing',
    'close-up':           'close-up shot, face focused, detailed expression',
    'extreme close-up':   'extreme close-up, macro detail, intense focus',
    'over the shoulder':  'over-the-shoulder shot, two characters, depth',
    'two-shot':           'two-shot, both characters visible, interaction',
    'point of view':      'POV shot, first-person perspective, immersive',
}

RESOLUTION_MAP = {
    '16:9':  (1280, 720),
    '9:16':  (720, 1280),
    '1:1':   (1024, 1024),
    '4:3':   (1024, 768),
    '3:4':   (768, 1024),
    '21:9':  (1920, 820),
}

# 角色形象参考图固定竖屏（与项目 videoRatio 无关）
CHARACTER_REFERENCE_RATIO = '9:16'


def build_image_prompt(
    panel: dict,
    art_style: str = 'cinematic',
    aspect_ratio: str = '16:9',
    *,
    prompt_suffix: str = '',
) -> tuple[str, str]:
    """
    构建优化的图像生成提示词

    Returns:
        (positive_prompt, negative_prompt)
    """
    parts = []

    if panel.get('imagePrompt'):
        parts.append(panel['imagePrompt'])
    else:
        if panel.get('description'):
            parts.append(panel['description'])
        if panel.get('action'):
            parts.append(panel['action'])
        if panel.get('location'):
            parts.append(f"setting: {panel['location']}")

    style_kw = ART_STYLE_KEYWORDS.get(art_style, ART_STYLE_KEYWORDS['cinematic'])
    parts.append(style_kw)

    shot_type = (panel.get('shotType') or '').lower()
    shot_kw = SHOT_TYPE_KEYWORDS.get(shot_type)
    if shot_kw:
        parts.append(shot_kw)

    mood = panel.get('mood', '')
    if mood:
        parts.append(f'{mood} mood, {mood} atmosphere')

    parts.append('high quality, detailed, professional composition')

    if prompt_suffix and str(prompt_suffix).strip():
        parts.append(str(prompt_suffix).strip())

    positive = ', '.join(p for p in parts if p)
    negative = (
        'blurry, low quality, distorted, deformed, ugly, bad anatomy, '
        'text, watermark, signature, oversaturated, poorly drawn'
    )
    return positive, negative


def get_resolution(aspect_ratio: str) -> tuple[int, int]:
    return RESOLUTION_MAP.get(aspect_ratio, RESOLUTION_MAP['16:9'])
