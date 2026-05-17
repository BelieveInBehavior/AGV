#!/usr/bin/env node
/**
 * 对 POST /api/generate/story 并发入队（测 Redis story 队列 + Celery Worker）。
 *
 * 用法:
 *   export JWT='<登录后 Bearer token>'
 *   export EPISODE_ID='<该剧集 episodeId>'
 *   export PROJECT_ID='proj_ad9d740bc5a7'   # 可选，默认即此项
 *   export API_ORIGIN='http://localhost:3011'  # 可选
 *   export COUNT=1000                      # 可选，总请求数
 *   export CONCURRENCY=1000                # 可选，同时 in-flight 数；过大可能触发本机 ulimit
 *
 *   node scripts/stress-story-analysis.mjs
 */

const API_ORIGIN = (process.env.API_ORIGIN || 'http://localhost:3011').replace(/\/$/, '');
let TOKEN = (process.env.JWT || process.env.TOKEN || '').trim();
if (TOKEN.toLowerCase().startsWith('bearer ')) {
  TOKEN = TOKEN.slice(7).trim();
}
const projectId = process.env.PROJECT_ID || 'proj_ad9d740bc5a7';
const episodeId = (process.env.EPISODE_ID || '').trim();
const COUNT = Math.max(1, Number(process.env.COUNT || 1000));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || COUNT));

async function one(i) {
  const started = Date.now();
  try {
    const r = await fetch(`${API_ORIGIN}/api/generate/story`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ projectId, episodeId }),
    });
    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { _raw: text.slice(0, 200) };
    }
    return { i, ok: r.ok, status: r.status, ms: Date.now() - started, body };
  } catch (e) {
    return { i, ok: false, status: 0, ms: Date.now() - started, error: String(e?.message || e) };
  }
}

async function runPool(total, limit, work) {
  let next = 0;
  const results = [];
  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= total) return;
      results.push(await work(i));
    }
  }
  const n = Math.min(limit, total);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function main() {
  if (!TOKEN) {
    console.error('缺少 JWT：请 export JWT=\'<Bearer 去掉 Bearer 前缀的 token>\'');
    process.exit(1);
  }
  if (!episodeId) {
    console.error('缺少 EPISODE_ID：请 export EPISODE_ID=\'<该剧集的 episodeId>\'');
    process.exit(1);
  }

  console.error(
    JSON.stringify(
      {
        API_ORIGIN,
        projectId,
        episodeId,
        COUNT,
        CONCURRENCY,
      },
      null,
      2
    )
  );

  const t0 = Date.now();
  return runPool(COUNT, CONCURRENCY, one).then((rows) => {
    const elapsed = Date.now() - t0;
    const byStatus = {};
    let ok = 0;
    for (const r of rows) {
      const k = String(r.status);
      byStatus[k] = (byStatus[k] || 0) + 1;
      if (r.ok) ok += 1;
    }
    const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
    const p = (q) => ms[Math.floor((ms.length - 1) * q)] ?? 0;
    console.log(
      JSON.stringify(
        {
          total: rows.length,
          httpOk: ok,
          byStatus,
          wallMs: elapsed,
          latencyMs: { min: ms[0], p50: p(0.5), p95: p(0.95), max: ms[ms.length - 1] },
        },
        null,
        2
      )
    );
    if (ok < rows.length) {
      const sample = rows.find((r) => !r.ok);
      if (sample) console.error('示例失败:', sample);
      process.exitCode = 1;
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
