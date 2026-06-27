import { API_BASE } from '../config/api';
import { getToken, assertApiAuthorized, ensureSessionValid, forceRelogin } from './auth';
import type { Project, Episode, Clip, Task, SseEvent, StoryboardMode, EpisodeEvaluation } from '../types/project';

export interface ArkVideoContentItem {
  type: 'text' | 'image_url' | 'video_url' | 'audio_url';
  text?: string;
  role?: 'reference_image' | 'reference_video' | 'reference_audio';
  image_url?: { url: string };
  video_url?: { url: string };
  audio_url?: { url: string };
}

export interface CreateArkVideoTaskInput {
  content?: ArkVideoContentItem[];
  prompt?: string;
  referenceImageUrls?: string[];
  referenceVideoUrl?: string;
  referenceAudioUrl?: string;
  model?: string;
  generateAudio?: boolean;
  ratio?: string;
  duration?: number;
  watermark?: boolean;
  apiKey?: string;
  baseUrl?: string;
}

function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` };
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...authHeaders(),
      ...(options?.headers as Record<string, string> | undefined),
    },
  });
  let data: T & { success?: boolean; message?: string };
  try {
    data = (await res.json()) as T & { success?: boolean; message?: string };
  } catch {
    if (res.status === 401) {
      forceRelogin();
    }
    throw new Error('Request failed');
  }
  assertApiAuthorized(res, data);
  if (!data.success) throw new Error(data.message || 'Request failed');
  return data as T;
}

// ── Projects ──────────────────────────────────────────────────────────
export async function listProjects(): Promise<Project[]> {
  const data = await request<{ projects: Project[] }>(`${API_BASE}/projects`);
  return data.projects;
}

export async function createProject(body: {
  name: string;
  description?: string;
  artStyle?: string;
  videoRatio?: string;
  language?: string;
}): Promise<Project> {
  const data = await request<{ project: Project }>(`${API_BASE}/projects`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data.project;
}

export async function getProject(projectId: string): Promise<Project> {
  const data = await request<{ project: Project }>(`${API_BASE}/projects/${projectId}`);
  return data.project;
}

export async function patchProjectReferences(
  projectId: string,
  body: {
    characters?: { name: string; referenceImageUrl?: string | null; imagePrompt?: string }[];
    locations?: { name: string; referenceImageUrl?: string | null; imagePrompt?: string }[];
    episodeId?: string;
  },
): Promise<Project> {
  const data = await request<{ project: Project }>(`${API_BASE}/projects/${projectId}/references`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return data.project;
}

export async function generateProjectReferenceImage(
  projectId: string,
  body: { kind: 'character' | 'location'; name: string; episodeId?: string },
): Promise<{ project: Project; imageUrl: string }> {
  const data = await request<{ project: Project; imageUrl: string }>(
    `${API_BASE}/projects/${projectId}/references/generate`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  return { project: data.project, imageUrl: data.imageUrl };
}

export async function patchClip(
  projectId: string,
  episodeId: string,
  clipId: string,
  body: {
    referenceOverrides?: Clip['referenceOverrides'] | null;
    beatPrompts?: {
      first_frame?: {
        scene_prompt?: string;
        description?: string;
        characters?: { name: string; outfit: string; emotion: string }[];
      };
      last_frame?: {
        scene_prompt?: string;
        description?: string;
        characters?: { name: string; outfit: string; emotion: string }[];
      };
    };
  },
): Promise<Clip> {
  const data = await request<{ clip: Clip }>(
    `${API_BASE}/projects/${projectId}/episodes/${episodeId}/clips/${clipId}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  return data.clip;
}

// ── Episodes ─────────────────────────────────────────────────────────
export async function listEpisodes(projectId: string): Promise<Episode[]> {
  const data = await request<{ episodes: Episode[] }>(`${API_BASE}/projects/${projectId}/episodes`);
  return data.episodes;
}

export async function createEpisode(
  projectId: string,
  body: { title?: string; novelText: string }
): Promise<Episode> {
  const data = await request<{ episode: Episode }>(`${API_BASE}/projects/${projectId}/episodes`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data.episode;
}

// ── Clips & Panels ───────────────────────────────────────────────────
export async function listClips(projectId: string, episodeId: string): Promise<Clip[]> {
  const data = await request<{ clips: Clip[] }>(
    `${API_BASE}/projects/${projectId}/episodes/${episodeId}/clips`
  );
  return data.clips;
}

// ── Generate ─────────────────────────────────────────────────────────
export async function generateStory(projectId: string, episodeId: string): Promise<string> {
  const data = await request<{ taskId: string }>(`${API_BASE}/generate/story`, {
    method: 'POST',
    body: JSON.stringify({ projectId, episodeId }),
  });
  return data.taskId;
}

/** 情节分析之后：仅 LLM 生成首尾帧 storyboardPlan（含 scene_prompt） */
export async function generateBeatPrompts(
  projectId: string,
  episodeId: string,
  clipIds?: string[]
): Promise<string> {
  const data = await request<{ taskId: string }>(`${API_BASE}/generate/beat-prompts`, {
    method: 'POST',
    body: JSON.stringify({ projectId, episodeId, clipIds }),
  });
  return data.taskId;
}

export async function generateStoryboard(
  projectId: string,
  episodeId: string,
  options?: { clipIds?: string[]; storyboardMode?: StoryboardMode }
): Promise<string> {
  const data = await request<{ taskId: string }>(`${API_BASE}/generate/storyboard`, {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      episodeId,
      clipIds: options?.clipIds,
      storyboardMode: options?.storyboardMode ?? 'auto',
    }),
  });
  return data.taskId;
}

export async function generateImages(
  projectId: string,
  episodeId?: string,
  panelIds?: string[]
): Promise<string> {
  const data = await request<{ taskId: string }>(`${API_BASE}/generate/images`, {
    method: 'POST',
    body: JSON.stringify({ projectId, episodeId, panelIds }),
  });
  return data.taskId;
}

export async function generateVideos(
  projectId: string,
  episodeId: string,
  clipIds?: string[]
): Promise<string> {
  const data = await request<{ taskId: string }>(`${API_BASE}/generate/videos`, {
    method: 'POST',
    body: JSON.stringify({ projectId, episodeId, clipIds }),
  });
  return data.taskId;
}

export async function evaluateEpisode(
  projectId: string,
  episodeId: string,
  scopes?: EpisodeEvaluation['scopes']
): Promise<string> {
  const data = await request<{ taskId: string }>(`${API_BASE}/generate/evaluation`, {
    method: 'POST',
    body: JSON.stringify({ projectId, episodeId, scopes }),
  });
  return data.taskId;
}

export async function createArkVideoTask(input: CreateArkVideoTaskInput): Promise<Record<string, unknown>> {
  const data = await request<{ result: Record<string, unknown> }>(`${API_BASE}/generate/videos/ark/tasks`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return data.result;
}

export async function getArkVideoTask(
  taskId: string,
  options?: { apiKey?: string; baseUrl?: string }
): Promise<Record<string, unknown>> {
  const query = new URLSearchParams();
  if (options?.apiKey) query.set('apiKey', options.apiKey);
  if (options?.baseUrl) query.set('baseUrl', options.baseUrl);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const data = await request<{ result: Record<string, unknown> }>(
    `${API_BASE}/generate/videos/ark/tasks/${encodeURIComponent(taskId)}${suffix}`,
    { method: 'GET' },
  );
  return data.result;
}

// ── Tasks ────────────────────────────────────────────────────────────
export async function getTask(taskId: string): Promise<Task> {
  const data = await request<{ task: Task }>(`${API_BASE}/tasks/${taskId}`);
  return data.task;
}

export async function listTasks(projectId: string): Promise<Task[]> {
  const data = await request<{ tasks: Task[] }>(`${API_BASE}/tasks?projectId=${projectId}`);
  return data.tasks;
}

// ── SSE ──────────────────────────────────────────────────────────────
export function connectSSE(onEvent: (event: SseEvent) => void): () => void {
  const token = getToken();
  const es = new EventSource(`${API_BASE}/sse${token ? `?token=${encodeURIComponent(token)}` : ''}`);

  let probeLock = false;
  const onEsError = () => {
    if (!token || probeLock) return;
    probeLock = true;
    void ensureSessionValid().finally(() => {
      window.setTimeout(() => {
        probeLock = false;
      }, 2000);
    });
  };
  es.addEventListener('error', onEsError);
  const handler = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as Record<string, unknown>;
      const taskId = String(data.taskId || '');
      if (!taskId) return;

      if (e.type === 'task.progress') {
        onEvent({
          type: 'task.progress',
          taskId,
          progress: Number(data.progress || 0),
          message: String(data.message || ''),
          stage: typeof data.stage === 'string' ? data.stage : undefined,
        });
      } else if (e.type === 'task.completed') {
        onEvent({ type: 'task.completed', taskId, result: data.result });
      } else if (e.type === 'task.error') {
        onEvent({ type: 'task.error', taskId, error: String(data.error || '任务失败') });
      }
    } catch {
      // ignore parse errors
    }
  };

  es.addEventListener('task.progress', handler);
  es.addEventListener('task.completed', handler);
  es.addEventListener('task.error', handler);

  return () => {
    es.removeEventListener('error', onEsError);
    es.close();
  };
}
