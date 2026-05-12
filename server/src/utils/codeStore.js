const codeStore = new Map();

export function generateCode(phone, expireSeconds = 300, fixedCode = null) {
  const code =
    fixedCode != null
      ? String(fixedCode)
      : String(Math.floor(100000 + Math.random() * 900000));
  codeStore.set(phone, {
    code,
    createdAt: Date.now(),
    expiresAt: Date.now() + expireSeconds * 1000,
    attempts: 0,
  });
  return code;
}

export function verifyCode(phone, code) {
  const item = codeStore.get(phone);
  if (!item) return { valid: false, message: '请先获取验证码' };
  if (Date.now() > item.expiresAt) {
    codeStore.delete(phone);
    return { valid: false, message: '验证码已过期，请重新获取' };
  }

  item.attempts += 1;
  if (item.attempts > 5) {
    codeStore.delete(phone);
    return { valid: false, message: '验证次数过多，请重新获取验证码' };
  }

  if (item.code !== code) return { valid: false, message: '验证码错误' };
  codeStore.delete(phone);
  return { valid: true, message: 'ok' };
}

export function isInCooldown(phone, cooldownSeconds = 60) {
  const entry = codeStore.get(phone);
  if (!entry) return false;
  const createdAt = entry.expiresAt - 300 * 1000;
  const elapsed = Date.now() - createdAt;
  return elapsed < cooldownSeconds * 1000;
}
