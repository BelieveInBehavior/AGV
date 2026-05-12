import { getToken } from './auth';
import type { AiSettings } from '../types/settings';

function authHeaders(): HeadersInit {
  const token = getToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function fetchAiSettings(): Promise<AiSettings> {
  const res = await fetch('/api/settings/ai', { headers: authHeaders() });
  const data = await res.json();
  if (!data.success) throw new Error(data.message || '加载设置失败');
  return data.settings as AiSettings;
}

export async function saveAiSettings(body: Record<string, unknown>): Promise<AiSettings> {
  const res = await fetch('/api/settings/ai', {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.message || '保存失败');
  return data.settings as AiSettings;
}
