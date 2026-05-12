/**
 * Redis 客户端 — ioredis 单例
 *
 * 热数据职责:
 *   task:{taskId}          → HASH 任务进度/状态   TTL 24h
 *   sms:code:{phone}       → HASH 验证码          TTL 300s
 *   sms:cooldown:{phone}   → STRING "1"           TTL 60s
 *   sse:events             → pub/sub channel
 */

import Redis from 'ioredis';
import config from '../config/index.js';

let _client = null;
let _subscriber = null; // 独立的 subscriber 连接（subscribe 模式下不能发其他命令）

function createClient() {
  return new Redis(config.redis.url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy(times) {
      return Math.min(times * 100, 3000);
    },
  });
}

/** 获取通用 Redis 客户端（读写） */
export function getRedis() {
  if (!_client) _client = createClient();
  return _client;
}

/** 获取专用 subscriber 客户端（只用于 subscribe） */
export function getSubscriber() {
  if (!_subscriber) _subscriber = createClient();
  return _subscriber;
}

export async function pingRedis() {
  return getRedis().ping();
}

export async function closeRedis() {
  const clients = [_client, _subscriber].filter(Boolean);
  await Promise.all(clients.map((client) => client.quit().catch(() => client.disconnect())));
  _client = null;
  _subscriber = null;
}

// ── 任务热状态 helpers ────────────────────────────────────────────

const TASK_TTL = 86400; // 24h

export async function setTaskHot(taskId, fields) {
  const r = getRedis();
  const key = `task:${taskId}`;
  await r.hset(key, ...Object.entries(fields).flat().map(String));
  await r.expire(key, TASK_TTL);
}

export async function getTaskHot(taskId) {
  return getRedis().hgetall(`task:${taskId}`);
}

// ── SMS 验证码 helpers (替换内存 codeStore) ──────────────────────

/**
 * 生成验证码并存入 Redis
 * @returns {string} code
 */
export async function generateCodeRedis(
  phone,
  expireSeconds = 300,
  cooldownSeconds = 60,
  fixedCode = null,
) {
  const r = getRedis();
  const code = fixedCode ?? String(Math.floor(100000 + Math.random() * 900000));
  const key = `sms:code:${phone}`;
  const cooldownKey = `sms:cooldown:${phone}`;

  await r
    .multi()
    .hset(key, 'code', code, 'attempts', '0')
    .expire(key, expireSeconds)
    .set(cooldownKey, '1', 'EX', cooldownSeconds)
    .exec();

  return code;
}

/**
 * 验证验证码
 * @returns {{ valid: boolean, message: string }}
 */
export async function verifyCodeRedis(phone, inputCode) {
  const r = getRedis();
  const key = `sms:code:${phone}`;
  const item = await r.hgetall(key);

  if (!item || !item.code) return { valid: false, message: '请先获取验证码' };

  const attempts = parseInt(item.attempts || '0', 10);
  if (attempts >= 5) {
    await r.del(key);
    return { valid: false, message: '验证次数过多，请重新获取验证码' };
  }
  await r.hincrby(key, 'attempts', 1);

  if (item.code !== inputCode) return { valid: false, message: '验证码错误' };

  await r.del(key, `sms:cooldown:${phone}`);
  return { valid: true, message: 'ok' };
}

/**
 * 检查发送冷却
 * @returns {boolean}
 */
export async function isInCooldownRedis(phone) {
  const exists = await getRedis().exists(`sms:cooldown:${phone}`);
  return exists === 1;
}
