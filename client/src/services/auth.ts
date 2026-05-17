import { API_BASE } from '../config/api';
import type { SendCodeResponse, UserInfo, VerifyCodeResponse } from '../types/auth';

const TOKEN_KEY = 'cwei_token';
const USER_KEY = 'cwei_user';

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/** 清除本地会话并进入登录页（整页跳转，确保 App 路由与状态一致） */
export function forceRelogin() {
  clearAuth();
  window.location.replace('/login');
}

type ApiBody = { success?: boolean; message?: string };

export function isUnauthorizedResponse(res: Response, body: ApiBody): boolean {
  if (res.status === 401) return true;
  if (body?.success !== false) return false;
  const m = String(body.message || '');
  return /token无效|已过期|^未登录$|无效的\s*token/i.test(m);
}

/** 若接口判定未授权，则跳转登录并抛出（避免继续执行业务逻辑） */
export function assertApiAuthorized(res: Response, body: ApiBody): void {
  if (isUnauthorizedResponse(res, body)) {
    forceRelogin();
    throw new Error(String(body.message || 'Unauthorized'));
  }
}

/** 用于 EventSource 等场景：用 user_info 探测会话；仅在网络成功且明确未授权时跳转登录 */
export async function ensureSessionValid(): Promise<void> {
  const token = getToken();
  if (!token) return;
  try {
    const res = await fetch(`${API_BASE}/auth/user_info`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
    const data = (await res.json().catch(() => ({}))) as ApiBody;
    if (isUnauthorizedResponse(res, data)) forceRelogin();
  } catch {
    // 网络异常不当作登出，避免误跳登录页
  }
}

export function setUserInfo(user: UserInfo) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export async function sendCode(phone: string): Promise<SendCodeResponse> {
  const response = await fetch(`${API_BASE}/auth/send_code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone_number: phone }),
  });
  return response.json();
}

export async function verifyCode(phone: string, code: string): Promise<VerifyCodeResponse> {
  const response = await fetch(`${API_BASE}/auth/verify_code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone_number: phone, code }),
  });
  return response.json();
}
