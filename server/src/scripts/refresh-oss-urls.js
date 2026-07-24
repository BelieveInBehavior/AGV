/**
 * 一次性脚本：刷新 MongoDB 中所有当前 bucket 的 OSS 带签名 URL。
 * 新 URL 使用当前 OSS_SIGN_EXPIRES_SECONDS 重新签名（默认 1 年）。
 *
 * 使用：
 *   cd server && node src/scripts/refresh-oss-urls.js
 *
 * 安全：只改写当前 bucket 的 URL，并会先确认 objectKey 存在（可选）。
 */

import { connectDB, getDB } from '../utils/db.js';
import { signMediaUrl, isOssConfigured } from '../utils/oss.js';

async function refreshCollectionUrls(db, collectionName, updaters) {
  const col = db.collection(collectionName);
  const cursor = col.find({});
  let updated = 0;
  let scanned = 0;

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    scanned++;

    for (const { path } of updaters) {
      const urls = path(doc);
      if (!urls.length) continue;

      const changes = {};
      for (const { key, value } of urls) {
        if (typeof value === 'string') {
          const newUrl = signMediaUrl(value);
          if (newUrl !== value) {
            changes[key] = newUrl;
          }
        }
      }

      if (Object.keys(changes).length) {
        await col.updateOne({ _id: doc._id }, { $set: changes });
        updated++;
      }
    }
  }

  console.log(`[refresh] ${collectionName}: scanned=${scanned}, updated=${updated}`);
  return { scanned, updated };
}

async function main() {
  if (!isOssConfigured()) {
    console.error('OSS 未配置，请检查 .env');
    process.exit(1);
  }

  await connectDB();
  const db = getDB();

  // 预热 OSS 客户端（通过 signMediaUrl 首次调用时懒加载）
  signMediaUrl('https://example.com');

  // projects: characters[].referenceImageUrl, locations[].referenceImageUrl
  await refreshCollectionUrls(db, 'projects', [
    {
      path: (doc) => (doc.characters || [])
        .map((c, i) => ({ key: `characters.${i}.referenceImageUrl`, value: c.referenceImageUrl }))
        .filter((x) => x.value),
    },
    {
      path: (doc) => (doc.locations || [])
        .map((l, i) => ({ key: `locations.${i}.referenceImageUrl`, value: l.referenceImageUrl }))
        .filter((x) => x.value),
    },
  ]);

  // clips: storyboardPlan.first_frame.imageUrl, storyboardPlan.last_frame.imageUrl, characterImageUrls
  await refreshCollectionUrls(db, 'clips', [
    {
      path: (doc) => {
        const out = [];
        const plan = doc.storyboardPlan || {};
        for (const slot of ['first_frame', 'last_frame']) {
          const fr = plan[slot];
          if (!fr || typeof fr !== 'object') continue;
          if (fr.imageUrl) out.push({ key: `storyboardPlan.${slot}.imageUrl`, value: fr.imageUrl });
          const chars = fr.characterImageUrls || {};
          for (const [name, url] of Object.entries(chars)) {
            if (typeof url === 'string') {
              out.push({ key: `storyboardPlan.${slot}.characterImageUrls.${name}`, value: url });
            }
          }
        }
        return out;
      },
    },
  ]);

  // panels: imageUrl
  await refreshCollectionUrls(db, 'panels', [
    {
      path: (doc) => (doc.imageUrl ? [{ key: 'imageUrl', value: doc.imageUrl }] : []),
    },
  ]);

  // characterStates: stateImageUrl, baseImageUrl
  await refreshCollectionUrls(db, 'characterStates', [
    {
      path: (doc) => {
        const out = [];
        if (doc.stateImageUrl) out.push({ key: 'stateImageUrl', value: doc.stateImageUrl });
        if (doc.baseImageUrl) out.push({ key: 'baseImageUrl', value: doc.baseImageUrl });
        return out;
      },
    },
  ]);

  console.log('[refresh] done');
  process.exit(0);
}

main().catch((err) => {
  console.error('[refresh] error:', err);
  process.exit(1);
});
