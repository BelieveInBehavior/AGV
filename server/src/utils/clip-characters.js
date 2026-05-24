/**
 * 跨 clip 角色在场回填（与 worker/utils/clip_characters.py 对齐）
 */

const ENTER_NEAR_NAME =
  /(?:进入|到达|走进|推门|进门|闯入|现身|赶来|到来|开门进入|推门进入|走进来|闯进来|推门而入|推门走进|出现在|来到)/;

const ENTER_GLOBAL =
  /(?:有人)?(?:进入|走进|推门进入|闯入|赶到|来到)(?:了)?(?:该|此|这个)?(?:房间|卧室|室内|场景|空间)/;

function clipText(clip) {
  return `${clip.content || ''}\n${clip.summary || ''}`;
}

export function characterEntersInClip(characterName, clip) {
  if (!characterName) return false;
  const text = clipText(clip);
  if (!text.trim()) return false;
  if (ENTER_GLOBAL.test(text)) return true;
  let m;
  const re = new RegExp(ENTER_NEAR_NAME.source, 'g');
  while ((m = re.exec(text)) !== null) {
    const start = Math.max(0, m.index - 40);
    const end = Math.min(text.length, m.index + m[0].length + 40);
    if (text.slice(start, end).includes(characterName)) return true;
  }
  return false;
}

function sameLocation(a, b) {
  const locA = (a.location || '').trim();
  const locB = (b.location || '').trim();
  if (!locA || !locB) return true;
  if (locA === locB) return true;
  const baseA = locA.split('_')[0];
  const baseB = locB.split('_')[0];
  return baseA === baseB;
}

/**
 * @param {Array<Record<string, unknown>>} clips
 * @returns {Array<Record<string, unknown>>}
 */
export function backfillClipCharacters(clips) {
  if (!clips?.length) return clips || [];

  const ordered = [...clips].sort(
    (a, b) => (a.clipIndex ?? 0) - (b.clipIndex ?? 0),
  );

  for (let i = 0; i < ordered.length - 1; i += 1) {
    const curr = ordered[i];
    const nxt = ordered[i + 1];
    if (!sameLocation(curr, nxt)) continue;

    const currList = [...(curr.characters || [])];
    const currSet = new Set(currList);
    for (const name of nxt.characters || []) {
      if (!name || currSet.has(name)) continue;
      if (characterEntersInClip(name, nxt)) continue;
      currList.push(name);
      currSet.add(name);
    }
    curr.characters = currList;
  }

  return ordered;
}
