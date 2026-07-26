export interface Character {
  name: string;
  /** 可选稳定 id（与 Worker included_character_ids / 状态缓存对齐） */
  characterId?: string;
  id?: string;
  aliases?: string[];
  description: string;
  role: 'protagonist' | 'antagonist' | 'supporting';
  /** LLM 生成的角色视觉 prompt（外貌、服装、体态等） */
  imagePrompt?: string;
  /** 项目级角色参考图 URL（新数据为 OSS https URL，兼容旧 data URL）；必须为竖屏 9:16 */
  referenceImageUrl?: string | null;
}

export interface Location {
  name: string;
  description: string;
  /** LLM 生成的场景视觉 prompt（含道具、NPC、氛围等） */
  imagePrompt?: string;
  referenceImageUrl?: string | null;
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

export interface EvaluationCriterion {
  score: number;
  comment: string;
}

export interface EvaluationIssue {
  severity: 'critical' | 'major' | 'minor' | 'info';
  targetType: string;
  targetId?: string;
  frame?: 'first_frame' | 'last_frame' | null;
  title: string;
  detail: string;
  suggestion: string;
}

export interface EvaluationScopeResult {
  scope: 'story_analysis' | 'beat_frames';
  score: number;
  grade: 'A' | 'B' | 'C' | 'D';
  verdict: 'pass' | 'warning' | 'fail';
  summary: string;
  criteria: Record<string, EvaluationCriterion>;
  issues: EvaluationIssue[];
  strengths: string[];
}

export interface EpisodeEvaluation {
  status: 'completed' | 'failed' | string;
  taskId: string;
  scopes: ('story_analysis' | 'beat_frames')[];
  createdAt: string;
  overall: {
    score: number;
    grade: 'A' | 'B' | 'C' | 'D';
    verdict: 'pass' | 'warning' | 'fail';
    summary: string;
    criticalIssueCount: number;
    majorIssueCount: number;
  };
  storyAnalysis?: EvaluationScopeResult;
  beatFrames?: EvaluationScopeResult;
}

export interface Episode {
  episodeId: string;
  projectId: string;
  episodeNumber: number;
  title: string;
  novelText: string;
  status:
    | 'draft'
    | 'analyzing'
    | 'analyzed'
    | 'beat_prompts_ready'
    | 'storyboard_ready'
    | 'images_ready'
    | 'video_ready'
    | 'editing'
    | 'edited'
    | 'complete';
  clipIds: string[];
  /** 全集拼接后的完整视频 URL */
  compiledVideoUrl?: string | null;
  /** 全集字幕文件 URL */
  subtitleUrl?: string | null;
  evaluation?: EpisodeEvaluation | null;
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

/** 首尾帧中单帧：静态生图 scene_prompt + characters；imagePrompt 仅作读兼容/回退 */
export interface BeatCharacterPose {
  name: string;
  outfit: string;
  emotion: string;
}

export interface BeatFrameSlot {
  description: string;
  /** v3：静态首/末帧生图 prompt */
  scene_prompt?: string;
  /** 旧版合一 prompt */
  imagePrompt?: string;
  characters?: BeatCharacterPose[];
  characterImageUrls?: Record<string, string>;
  imageUrl?: string | null;
  imagePromptUsed?: string;
  imageError?: string;
  status?: string;
  /** 由上一情节视频尾部抽帧得到的连续性首帧参考，不覆盖原始首帧图 */
  continuityImageUrl?: string | null;
  continuitySourceClipId?: string | null;
}

export interface VideoReferenceAssets {
  videoUrls?: string[];
  audioUrls?: string[];
}

export interface StoryboardPlan {
  /** 单镜头视频 prompt（结构化中文） */
  video_prompt?: string;
  /** 与上一情节衔接（生图完成后批处理写入；首段为空） */
  transition_from_prev?: string;
  included_character_ids?: string[];
  /** 扁平首末帧（v2 主流程） */
  first_frame?: BeatFrameSlot;
  last_frame?: BeatFrameSlot;
  /** 参考图变更后由 API 置 true，重新生成首尾帧 Prompt 后清除 */
  referenceStale?: boolean;
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
  sceneComplexity?: 'simple' | 'complex';
  /** LLM 预估的视频时长（秒，5-15） */
  duration?: number;
  storyboardPlan?: StoryboardPlan | null;
  /** 首尾帧链路生成的视频 URL（Mongo clip 顶层字段） */
  videoUrl?: string | null;
  /** 剪辑后的最终视频 URL（从完整集视频剪辑得到） */
  editedVideoUrl?: string | null;
  /** 字幕文件 URL（SRT/WebVTT） */
  subtitleUrl?: string | null;
  panels: Panel[];
  /** 本情节临时覆盖参考图（角色名 → URL；locationImage 覆盖当前场景，优先 OSS URL） */
  referenceOverrides?: {
    characterImages?: Record<string, string>;
    locationImage?: string | null;
  } | null;
  /** Ark / Seedance 主视频链路的额外参考视频/音频 URL */
  videoReferenceAssets?: VideoReferenceAssets | null;
}

export interface Task {
  taskId: string;
  type: 'STORY_ANALYSIS' | 'BEAT_PROMPT_GEN' | 'STORYBOARD_GEN' | 'IMAGE_GENERATION' | 'VIDEO_GENERATION' | 'VIDEO_EDITING' | 'EPISODE_EVALUATION' | 'EXTRACT_VIDEO_FRAMES' | 'PARSE_SUBTITLE_LANGUAGE';
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

export type StoryboardMode = 'auto' | 'beat_frames' | 'panels';
