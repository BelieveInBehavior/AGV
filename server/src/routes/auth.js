import { Router } from 'express';
import { sendSmsCode } from '../utils/sms.js';
import { authMiddleware, generateToken } from '../utils/jwt.js';
import { createUser, findUserById, findUserByPhone, updateUser } from '../utils/users.js';
import config from '../config/index.js';
import { generateCodeRedis, isInCooldownRedis, verifyCodeRedis } from '../utils/redis.js';

const router = Router();

router.post('/send_code', async (req, res) => {
  const rawPhone = req.body?.phone_number;
  const phone_number = String(rawPhone ?? '').trim();
  if (!phone_number || !/^1\d{10}$/.test(phone_number)) {
    return res.status(400).json({ success: false, message: '请输入正确的手机号' });
  }

  if (await isInCooldownRedis(phone_number)) {
    return res.status(429).json({ success: false, message: '请求过于频繁，请稍后再试' });
  }

  const testPhone = String(config.testAuth.phoneNumber || '15000361623').trim();
  const testCode = String(config.testAuth.code || '123456').trim();
  const isTestPhone = phone_number === testPhone;
  const code = await generateCodeRedis(
    phone_number,
    config.aliyunSms.codeExpireSeconds,
    config.aliyunSms.sendCodeCooldownSeconds,
    isTestPhone ? testCode : null,
  );
  const result = await sendSmsCode(phone_number, code);
  return res.json({
    success: result.success,
    message: result.message,
    request_id: result.requestId,
  });
});

router.post('/verify_code', async (req, res) => {
  const phone_number = String(req.body?.phone_number ?? '').trim();
  const code = String(req.body?.code ?? '').trim();
  if (!phone_number || !code) {
    return res.status(400).json({ success: false, message: '缺少参数' });
  }

  const testPhone = String(config.testAuth.phoneNumber || '15000361623').trim();
  const testCode = String(config.testAuth.code || '123456').trim();
  const isTestPass = phone_number === testPhone && code === testCode;
  const codeResult = isTestPass ? { valid: true, message: 'ok' } : await verifyCodeRedis(phone_number, code);
  if (!codeResult.valid) return res.json({ success: false, message: codeResult.message });

  let user = await findUserByPhone(phone_number);
  if (!user) {
    user = await createUser(phone_number);
  } else {
    await updateUser(user.user_id, { last_login_time: new Date() });
  }

  const { token, expiresIn } = generateToken(user.user_id);
  return res.json({
    success: true,
    message: '登录成功',
    token,
    expires_in: expiresIn,
    user_info: {
      user_id: user.user_id,
      phone: phone_number,
      nickname: `用户${phone_number.slice(-4)}`,
    },
  });
});

router.get('/user_info', authMiddleware, async (req, res) => {
  const user = await findUserById(req.user.uid);
  if (!user) return res.status(404).json({ success: false, message: '用户不存在' });
  return res.json({
    success: true,
    user_info: {
      user_id: user.user_id,
      phone: user.phone,
      nickname: `用户${user.phone.slice(-4)}`,
      created_at: user.created_at,
    },
  });
});

export default router;
