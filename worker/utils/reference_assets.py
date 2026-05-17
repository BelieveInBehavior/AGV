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
