"""Collect character / location reference image URLs for a clip (project library + per-clip overrides)."""

from __future__ import annotations

from base64 import b64encode
from datetime import datetime
from email.utils import formatdate
import hashlib
import hmac
import mimetypes
import os
from pathlib import Path
from uuid import uuid4
from urllib.parse import parse_qsl, quote, urlencode, urlparse
from urllib.request import Request, urlopen


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


def _load_oss_config() -> tuple[str, str, str, str]:
    oss_key = os.getenv('OSS_ACCESS_KEY_ID')
    oss_secret = os.getenv('OSS_ACCESS_KEY_SECRET')
    oss_bucket = os.getenv('OSS_BUCKET')
    oss_endpoint = os.getenv('OSS_ENDPOINT')

    if not all([oss_key, oss_secret, oss_bucket, oss_endpoint]):
        try:
            import config  # noqa: F401  # load_dotenv side effect
        except Exception:
            pass
        oss_key = os.getenv('OSS_ACCESS_KEY_ID')
        oss_secret = os.getenv('OSS_ACCESS_KEY_SECRET')
        oss_bucket = os.getenv('OSS_BUCKET')
        oss_endpoint = os.getenv('OSS_ENDPOINT')

    if not all([oss_key, oss_secret, oss_bucket, oss_endpoint]):
        raise ValueError('OSS not configured')

    return str(oss_key), str(oss_secret), str(oss_bucket), str(oss_endpoint)


def _build_object_key(file_name: str, sub_dir: str, fallback_ext: str = '') -> str:
    timestamp = int(datetime.now().timestamp() * 1000)
    uuid_short = str(uuid4())[:8]
    ext = Path(file_name or '').suffix.lower()
    final_ext = ext or fallback_ext.lower()
    return f"AGV/{sub_dir}/{timestamp}_{uuid_short}{final_ext}"


def _build_object_url(oss_bucket: str, oss_endpoint: str, object_key: str) -> str:
    encoded_key = '/'.join(quote(part, safe='') for part in object_key.split('/'))
    return f"https://{oss_bucket}.{oss_endpoint}/{encoded_key}"


def _build_signed_get_url(
    oss_key: str,
    oss_secret: str,
    oss_bucket: str,
    oss_endpoint: str,
    object_key: str,
    expires_seconds: int = 315360000,
) -> str:
    expires_at = int(datetime.now().timestamp()) + max(int(expires_seconds), 1)
    canonical_resource = f'/{oss_bucket}/{object_key}'
    string_to_sign = f'GET\n\n\n{expires_at}\n{canonical_resource}'
    signature = b64encode(
        hmac.new(oss_secret.encode('utf-8'), string_to_sign.encode('utf-8'), hashlib.sha1).digest()
    ).decode('utf-8')
    query = urlencode({
        'OSSAccessKeyId': oss_key,
        'Expires': str(expires_at),
        'Signature': signature,
    })
    return f'{_build_object_url(oss_bucket, oss_endpoint, object_key)}?{query}'


def _upload_bytes_to_oss(
    payload: bytes,
    *,
    content_type: str,
    object_key: str,
    cache_control: str = 'public, max-age=31536000',
) -> dict:
    oss_key, oss_secret, oss_bucket, oss_endpoint = _load_oss_config()

    if not payload:
        raise ValueError('Upload payload is empty')

    def signed_url() -> str:
        return _build_signed_get_url(oss_key, oss_secret, oss_bucket, oss_endpoint, object_key)

    def object_url() -> str:
        return _build_object_url(oss_bucket, oss_endpoint, object_key)

    try:
        import oss2

        auth = oss2.Auth(oss_key, oss_secret)
        bucket = oss2.Bucket(auth, f"https://{oss_endpoint}", oss_bucket)
        bucket.put_object(object_key, payload, headers={
            'Content-Type': content_type,
            'Cache-Control': cache_control,
        })
        return {'url': signed_url(), 'objectKey': object_key}
    except ImportError:
        pass
    except Exception as e:
        raise ValueError(f'Failed to upload to OSS: {e}')

    try:
        request_date = formatdate(usegmt=True)
        canonical_resource = f'/{oss_bucket}/{object_key}'
        string_to_sign = f'PUT\n\n{content_type}\n{request_date}\n{canonical_resource}'
        signature = b64encode(
            hmac.new(oss_secret.encode('utf-8'), string_to_sign.encode('utf-8'), hashlib.sha1).digest()
        ).decode('utf-8')

        req = Request(object_url(), data=payload, method='PUT')
        req.add_header('Date', request_date)
        req.add_header('Content-Type', content_type)
        req.add_header('Cache-Control', cache_control)
        req.add_header('Authorization', f'OSS {oss_key}:{signature}')
        req.add_header('Content-Length', str(len(payload)))

        with urlopen(req, timeout=300) as resp:
            status = getattr(resp, 'status', None) or resp.getcode()
            if status < 200 or status >= 300:
                raise ValueError(f'OSS upload failed with status {status}')

        return {'url': signed_url(), 'objectKey': object_key}
    except Exception as e:
        raise ValueError(f'Failed to upload to OSS without oss2: {e}')


def upload_image_data_url_to_oss(data_url: str, file_name: str = '', sub_dir: str = 'uploads') -> dict:
    """将 base64 data URL 上传到 OSS。返回 {'url': oss_url, 'objectKey': key}"""
    import base64
    import re

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

    object_key = _build_object_key(file_name, sub_dir, ext)
    return _upload_bytes_to_oss(image_buffer, content_type=mime_type, object_key=object_key)


def upload_file_to_oss(
    file_path: str,
    file_name: str = '',
    sub_dir: str = 'uploads',
    content_type: str | None = None,
) -> dict:
    """上传本地文件到 OSS。返回 {'url': oss_url, 'objectKey': key}"""
    local_path = Path(file_path)
    if not local_path.exists() or not local_path.is_file():
        raise ValueError('Upload file does not exist')

    resolved_file_name = file_name or local_path.name
    guessed_type = (content_type or mimetypes.guess_type(resolved_file_name)[0] or 'application/octet-stream').strip()
    fallback_ext = Path(resolved_file_name).suffix.lower()
    object_key = _build_object_key(resolved_file_name, sub_dir, fallback_ext)

    with local_path.open('rb') as fh:
        payload = fh.read()

    return _upload_bytes_to_oss(payload, content_type=guessed_type, object_key=object_key)


def sign_oss_url(raw_url: str | None, expires_seconds: int = 315360000) -> str | None:
    """为当前 OSS bucket 的对象 URL 生成可下载签名；已带签名或非当前 bucket URL 则原样返回。"""
    if not isinstance(raw_url, str) or not raw_url.strip():
        return raw_url

    safe_url = raw_url.strip()
    parsed = urlparse(safe_url)
    if not parsed.scheme or not parsed.netloc:
        return safe_url

    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    if {'OSSAccessKeyId', 'Expires', 'Signature'}.issubset(query.keys()):
        return safe_url

    try:
        oss_key, oss_secret, oss_bucket, oss_endpoint = _load_oss_config()
    except ValueError:
        return safe_url

    if parsed.netloc != f'{oss_bucket}.{oss_endpoint}':
        return safe_url

    object_key = '/'.join(
        segment for segment in (
            parsed.path or ''
        ).split('/') if segment
    )
    if not object_key:
        return safe_url

    return _build_signed_get_url(
        oss_key,
        oss_secret,
        oss_bucket,
        oss_endpoint,
        object_key,
        expires_seconds=expires_seconds,
    )
