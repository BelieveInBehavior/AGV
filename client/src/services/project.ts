import { getToken } from './auth';
import type { Project, Episode, Clip, Task, SseEvent } from '../types/project';

const API = '/api';

function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` };
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: authHeaders(), ...options });
  const data = await res.json();
  if (!data.success) throw new Error(data.message || 'Request failed');
  return data as T;
}

// ── Projects ──────────────────────────────────────────────────────────
export async function listProjects(): Promise<Project[]> {
  const data = await request<{ projects: Project[] }>(`${API}/projects`);
  return data.projects;
}

export async function createProject(body: {
  name: string;
  description?: string;
  artStyle?: string;
  videoRatio?: string;
  language?: string;
}): Promise<Project> {
  const data = await request<{ project: Project }>(`${API}/projects`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data.project;
}

export async function getProject(projectId: string): Promise<Project> {
  const data = await request<{ project: Project }>(`${API}/projects/${projectId}`);
  return data.project;
}

// ── Episodes ─────────────────────────────────────────────────────────
export async function listEpisodes(projectId: string): Promise<Episode[]> {
  const data = await request<{ episodes: Episode[] }>(`${API}/projects/${projectId}/episodes`);
  return data.episodes;
}

export async function createEpisode(
  projectId: string,
  body: { title?: string; novelText: string }
): Promise<Episode> {
  const data = await request<{ episode: Episode }>(`${API}/projects/${projectId}/episodes`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data.episode;
}

// ── Clips & Panels ───────────────────────────────────────────────────
export async function listClips(projectId: string, episodeId: string): Promise<Clip[]> {
  const data = await request<{ clips: Clip[] }>(
    `${API}/projects/${projectId}/episodes/${episodeId}/clips`
  );
  return data.clips;
}

// ── Generate ─────────────────────────────────────────────────────────
export async function generateStory(projectId: string, episodeId: string): Promise<string> {
  const data = await request<{ taskId: string }>(`${API}/generate/story`, {
    method: 'POST',
    body: JSON.stringify({ projectId, episodeId }),
  });
  return data.taskId;
}

export async function generateStoryboard(
  projectId: string,
  episodeId: string,
  clipIds?: string[]
): Promise<string> {
  const data = await request<{ taskId: string }>(`${API}/generate/storyboard`, {
    method: 'POST',
    body: JSON.stringify({ projectId, episodeId, clipIds }),
  });
  return data.taskId;
}

export async function generateImages(
  projectId: string,
  episodeId?: string,
  panelIds?: string[]
): Promise<string> {
  const data = await request<{ taskId: string }>(`${API}/generate/images`, {
    method: 'POST',
    body: JSON.stringify({ projectId, episodeId, panelIds }),
  });
  return data.taskId;
}

// ── Tasks ────────────────────────────────────────────────────────────
export async function getTask(taskId: string): Promise<Task> {
  const data = await request<{ task: Task }>(`${API}/tasks/${taskId}`);
  return data.task;
}

export async function listTasks(projectId: string): Promise<Task[]> {
  const data = await request<{ tasks: Task[] }>(`${API}/tasks?projectId=${projectId}`);
  return data.tasks;
}

// ── SSE ──────────────────────────────────────────────────────────────
export function connectSSE(onEvent: (event: SseEvent) => void): () => void {
  const token = getToken();
  const es = new EventSource(`${API}/sse${token ? `?token=${token}` : ''}`);

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

  return () => es.close();
}
