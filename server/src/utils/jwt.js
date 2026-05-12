import jwt from 'jsonwebtoken';
import config from '../config/index.js';

export function generateToken(uid) {
  const token = jwt.sign({ uid }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
  return { token, expiresIn: config.jwt.expiresIn };
}

export function parseToken(token) {
  try {
    return jwt.verify(token, config.jwt.secret);
  } catch {
    return null;
  }
}

export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: '未登录' });
  }

  const token = authHeader.slice(7);
  const decoded = parseToken(token);
  if (!decoded) {
    return res.status(401).json({ success: false, message: 'token无效或已过期' });
  }

  req.user = decoded;
  req.userId = decoded.uid;
  next();
}
