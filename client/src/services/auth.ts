import type { SendCodeResponse, UserInfo, VerifyCodeResponse } from '../types/auth';

const TOKEN_KEY = 'cwei_token';
const USER_KEY = 'cwei_user';

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setUserInfo(user: UserInfo) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export async function sendCode(phone: string): Promise<SendCodeResponse> {
  const response = await fetch('/api/auth/send_code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone_number: phone }),
  });
  return response.json();
}

export async function verifyCode(phone: string, code: string): Promise<VerifyCodeResponse> {
  const response = await fetch('/api/auth/verify_code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone_number: phone, code }),
  });
  return response.json();
}
