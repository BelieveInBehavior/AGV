export interface Character {
  name: string;
  aliases?: string[];
  description: string;
  role: 'protagonist' | 'antagonist' | 'supporting';
}

export interface Location {
  name: string;
  description: string;
}

export interface Project {
  projectId: string;
  userId: string;
  name: string;
  description: string;
  artStyle: string;
  imageModel: string;
  videoRatio: string;
  language: string;
  characters: Character[];
  locations: Location[];
  createdAt: string;
  updatedAt: string;
}

export interface Episode {
  episodeId: string;
  projectId: string;
  episodeNumber: number;
  title: string;
  novelText: string;
  status: 'draft' | 'analyzing' | 'analyzed' | 'storyboard_ready' | 'complete';
  clipIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Panel {
  panelId: string;
  clipId: string;
  panelIndex: number;
  description: string;
  characters: string[];
  location: string;
  shotType: string;
  cameraMovement: string;
  mood: string;
  action: string;
  dialogue: string;
  imagePrompt: string;
  videoPrompt: string;
  imageUrl: string | null;
  videoUrl: string | null;
  status: 'draft' | 'generating_image' | 'image_ready' | 'generating_video' | 'complete';
}

export interface Clip {
  clipId: string;
  episodeId: string;
  clipIndex: number;
  content: string;
  summary: string;
  characters: string[];
  location: string;
  mood: string;
  panels: Panel[];
}

export interface Task {
  taskId: string;
  type: 'STORY_ANALYSIS' | 'STORYBOARD_GEN' | 'IMAGE_GENERATION';
  status: 'pending' | 'queued' | 'claimed' | 'running' | 'retrying' | 'completed' | 'failed';
  progress: number;
  message: string;
  error: string | null;
  result: Record<string, unknown> | null;
  projectId?: string;
  episodeId?: string | null;
  /** 仅 GET /api/tasks/:taskId：未开始执行时附带 Celery 队列积压，便于排障 */
  celeryQueue?: { queue: string; backlog: number | null } | null;
  createdAt: string;
  updatedAt: string;
}

export type SseEvent =
  | { type: 'task.progress'; taskId: string; progress: number; message: string; stage?: string }
  | { type: 'task.completed'; taskId: string; result?: unknown }
  | { type: 'task.error'; taskId: string; error: string };
