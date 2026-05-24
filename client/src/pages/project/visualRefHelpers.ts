import type { Clip, Project } from '../../types/project';

export function effectiveLocationRefUrl(project: Project, clip: Clip): string | null {
  const o = clip.referenceOverrides?.locationImage;
  if (o && String(o).trim()) return String(o).trim();
  const loc = project.locations.find((l) => l.name.trim() === clip.location.trim());
  const u = loc?.referenceImageUrl;
  return u && String(u).trim() ? String(u).trim() : null;
}

export function effectiveCharacterRefUrl(project: Project, clip: Clip, characterName: string): string | null {
  const key = characterName.trim();
  const o = clip.referenceOverrides?.characterImages?.[key];
  if (o && String(o).trim()) return String(o).trim();
  const c = project.characters.find((x) => x.name.trim() === key);
  const u = c?.referenceImageUrl;
  return u && String(u).trim() ? String(u).trim() : null;
}

/** 与 Worker 一致：场景优先，再按情节角色顺序 */
export function collectClipReferenceUrls(project: Project, clip: Clip): string[] {
  const urls: string[] = [];
  const loc = effectiveLocationRefUrl(project, clip);
  if (loc) urls.push(loc);
  for (const name of clip.characters || []) {
    const u = effectiveCharacterRefUrl(project, clip, name);
    if (u) urls.push(u);
  }
  return [...new Set(urls)];
}

export function sceneRefReady(project: Project, clip: Clip): boolean {
  return Boolean(effectiveLocationRefUrl(project, clip));
}
