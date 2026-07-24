"""Collect character / location reference image URLs for a clip (project library + per-clip overrides)."""


def location_reference_url(project: dict | None, clip: dict | None) -> str | None:
    """仅场景 establishing 参考图 URL（无则 None）。"""
    if not project or not clip:
        return None
    overrides = clip.get('referenceOverrides') or {}
    loc_override = overrides.get('locationImage')
    if isinstance(loc_override, str) and loc_override.strip():
        return loc_override.strip()
    loc_name = (clip.get('location') or '').strip()
    if not loc_name:
        return None
    for loc in project.get('locations') or []:
        if (loc.get('name') or '').strip() == loc_name:
            u = (loc.get('referenceImageUrl') or '').strip()
            return u or None
    return None


def character_reference_url(project: dict | None, clip: dict | None, name: str) -> str | None:
    """单个角色的基础参考图 URL：本段覆盖优先，其次项目资产库。"""
    if not project or not clip or not name:
        return None
    key = (name or '').strip()
    if not key:
        return None

    overrides = clip.get('referenceOverrides') or {}
    char_over = overrides.get('characterImages') or {}
    over = char_over.get(key)
    if isinstance(over, str) and over.strip():
        return over.strip()

    for c in project.get('characters') or []:
        if (c.get('name') or '').strip() == key:
            u = (c.get('referenceImageUrl') or '').strip()
            return u or None
    return None


def collect_reference_urls(project: dict | None, clip: dict | None) -> list[str]:
    """
    Order: location first (establishing), then characters in clip order.
    URLs may be https or data:image/... (fal may accept data URLs for some models).
    """
    if not project or not clip:
        return []

    overrides = clip.get('referenceOverrides') or {}
    char_over = overrides.get('characterImages') or {}
    loc_override = overrides.get('locationImage')

    urls: list[str] = []

    loc_name = (clip.get('location') or '').strip()
    if isinstance(loc_override, str) and loc_override.strip():
        urls.append(loc_override.strip())
    elif loc_name:
        for loc in project.get('locations') or []:
            if (loc.get('name') or '').strip() == loc_name:
                u = (loc.get('referenceImageUrl') or '').strip()
                if u:
                    urls.append(u)
                break

    for name in clip.get('characters') or []:
        key = (name or '').strip()
        if not key:
            continue
        if isinstance(char_over.get(key), str) and char_over[key].strip():
            urls.append(char_over[key].strip())
            continue
        for c in project.get('characters') or []:
            if (c.get('name') or '').strip() == key:
                u = (c.get('referenceImageUrl') or '').strip()
                if u:
                    urls.append(u)
                break

    # de-dupe preserving order
    seen: set[str] = set()
    out: list[str] = []
    for u in urls:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def collect_frame_reference_urls(
    project: dict | None,
    clip: dict | None,
    frame: dict | None,
    *,
    character_state_urls: dict[str, str] | None = None,
) -> list[str]:
    """
    首尾帧专用参考图选择：
    1. 场景图始终优先
    2. 只取当前 frame.characters 中实际入镜角色
    3. 每个角色优先角色状态图，再退回角色基础参考图
    """
    if not project or not clip:
        return []

    urls: list[str] = []
    loc_u = location_reference_url(project, clip)
    if loc_u:
        urls.append(loc_u)

    state_urls = character_state_urls or {}
    visible_names: list[str] = []
    if isinstance(frame, dict):
        for ch in frame.get('characters') or []:
            if not isinstance(ch, dict):
                continue
            name = (ch.get('name') or '').strip()
            if name:
                visible_names.append(name)

    if not visible_names:
        for name in clip.get('characters') or []:
            nm = (name or '').strip()
            if nm:
                visible_names.append(nm)

    seen_names: set[str] = set()
    for name in visible_names:
        if name in seen_names:
            continue
        seen_names.add(name)
        st = (state_urls.get(name) or '').strip()
        if st:
            urls.append(st)
            continue
        base = character_reference_url(project, clip, name)
        if base:
            urls.append(base)

    seen_urls: set[str] = set()
    out: list[str] = []
    for url in urls:
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        out.append(url)
    return out


def reference_descriptions_for_prompt(project: dict | None, clip: dict | None) -> str:
    """Short textual anchors from descriptions (always safe for txt2img)."""
    if not project or not clip:
        return ''

    parts: list[str] = []
    loc_name = (clip.get('location') or '').strip()
    if loc_name:
        for loc in project.get('locations') or []:
            if (loc.get('name') or '').strip() == loc_name:
                d = (loc.get('description') or '').strip()
                if d:
                    parts.append(f"Setting ({loc_name}): {d[:200]}")
                break

    for name in clip.get('characters') or []:
        key = (name or '').strip()
        if not key:
            continue
        for c in project.get('characters') or []:
            if (c.get('name') or '').strip() == key:
                # Only inject text description if no reference image — reference image takes priority
                has_ref = bool((c.get('referenceImageUrl') or '').strip())
                if not has_ref:
                    d = (c.get('imagePrompt') or c.get('description') or '').strip()
                    if d:
                        parts.append(f"Character ({key}): {d[:300]}")
                break

    if not parts:
        return ''
    return 'Consistency anchors — ' + ' | '.join(parts)


def upload_image_data_url_to_oss(data_url: str, file_name: str = '', sub_dir: str = 'uploads') -> dict:
    """将 base64 data URL 上传到 OSS。返回 {'url': oss_url, 'objectKey': key}"""
    import base64
    import re
    import os
    from datetime import datetime
    from uuid import uuid4

    if not isinstance(data_url, str) or not data_url.startswith('data:'):
        raise ValueError('Invalid data URL format')

    # 解析 data URL: data:image/jpeg;base64,xxx
    match = re.match(r'^data:([^;,]+);base64,(.+)$', data_url)
    if not match:
        raise ValueError('Invalid data URL format')

    mime_type, base64_str = match.groups()
    mime_type = mime_type.lower()

    # 提取扩展名
    mime_to_ext = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
        'image/gif': '.gif',
    }
    ext = mime_to_ext.get(mime_type, '.jpg')

    # 解码 base64
    try:
        image_buffer = base64.b64decode(base64_str)
    except Exception as e:
        raise ValueError(f'Failed to decode base64: {e}')

    if not image_buffer:
        raise ValueError('Image buffer is empty')

    # 生成 object key
    timestamp = int(datetime.now().timestamp() * 1000)
    uuid_short = str(uuid4())[:8]
    object_key = f"AGV/{sub_dir}/{timestamp}_{uuid_short}{ext}"

    # 上传到 OSS
    try:
        import oss2

        # 从环境变量读取 OSS 配置
        oss_key = os.getenv('OSS_ACCESS_KEY_ID')
        oss_secret = os.getenv('OSS_ACCESS_KEY_SECRET')
        oss_bucket = os.getenv('OSS_BUCKET')
        oss_endpoint = os.getenv('OSS_ENDPOINT')

        if not all([oss_key, oss_secret, oss_bucket, oss_endpoint]):
            raise ValueError('OSS not configured')

        auth = oss2.Auth(oss_key, oss_secret)
        bucket = oss2.Bucket(auth, f"https://{oss_endpoint}", oss_bucket)

        bucket.put_object(object_key, image_buffer, headers={
            'Content-Type': mime_type,
            'Cache-Control': 'public, max-age=31536000',
        })

        # 生成 URL
        url = f"https://{oss_bucket}.{oss_endpoint}/{object_key}"

        return {
            'url': url,
            'objectKey': object_key,
        }
    except ImportError:
        raise ValueError('oss2 library not installed')
    except Exception as e:
        raise ValueError(f'Failed to upload to OSS: {e}')
