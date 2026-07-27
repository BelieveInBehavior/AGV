import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  getProject,
  listEpisodes,
  createEpisode,
  listClips,
  generateStory,
  generateBeatPrompts,
  generateStoryboard,
  generateImages,
  generateVideos,
  editVideos,
  extractVideoFrames,
  evaluateEpisode,
  getTask,
  listTasks,
  connectSSE,
} from '../../services/project';
import { CHARACTER_REFERENCE_RATIO } from '../../config/visual-assets';
import type { Project, Episode, Clip, Task, SseEvent, StoryboardMode } from '../../types/project';
import { VisualAssetLibrary } from './VisualAssetLibrary';
import { BeatKeyframeEditor } from './BeatKeyframeEditor';
import {
  EpisodeEvaluationModal,
  EvaluationScoreBadge,
  hasEvaluationForScope,
} from './EpisodeEvaluationPanel';
import {
  hasBeatStoryboardContent,
  resolveVideoFirstFrameRef,
  storyboardPlanForDisplay,
} from './beatPlanHelpers';
import { effectiveCharacterRefUrl, sceneRefReady } from './visualRefHelpers';

type Stage = 'input' | 'clips' | 'prompts' | 'editing';
type EvaluationScope = 'story_analysis' | 'beat_frames' | 'all';
type SubtitleAnimation =
  | 'none'
  | 'fade'
  | 'slide-up'
  | 'slide-down'
  | 'slide-left'
  | 'slide-right'
  | 'pop'
  | 'bounce'
  | 'pulse'
  | 'blur-in'
  | 'flip';
type SubtitleStyleCategory = 'basic' | 'bubble' | 'fancy';
type SubtitleInspectorTab = 'content' | 'style' | 'motion';
type SubtitleStylePreset =
  | 'caption-solid'
  | 'caption-glass'
  | 'caption-outline'
  | 'bubble-rounded'
  | 'bubble-chat'
  | 'bubble-pill'
  | 'bubble-cloud'
  | 'bubble-thought'
  | 'bubble-note'
  | 'bubble-shout'
  | 'bubble-whisper'
  | 'highlight-tape'
  | 'sticker-pop'
  | 'comic-burst';
type SubtitleCue = {
  start: number;
  end: number;
  text: string;
  vertical: 'top' | 'middle' | 'bottom';
  align: 'start' | 'center' | 'end';
  x: number;
  y: number;
  animation: SubtitleAnimation;
  stylePreset: SubtitleStylePreset;
};

const SUBTITLE_VERTICAL_OPTIONS: { label: string; value: SubtitleCue['vertical'] }[] = [
  { label: '上方', value: 'top' },
  { label: '中间', value: 'middle' },
  { label: '下方', value: 'bottom' },
];

const SUBTITLE_ALIGN_OPTIONS: { label: string; value: SubtitleCue['align'] }[] = [
  { label: '左对齐', value: 'start' },
  { label: '居中', value: 'center' },
  { label: '右对齐', value: 'end' },
];

const SUBTITLE_ANIMATION_OPTIONS: { label: string; value: SubtitleAnimation }[] = [
  { label: '淡入', value: 'fade' },
  { label: '上浮', value: 'slide-up' },
  { label: '下落', value: 'slide-down' },
  { label: '左滑', value: 'slide-left' },
  { label: '右滑', value: 'slide-right' },
  { label: '弹出', value: 'pop' },
  { label: '弹跳', value: 'bounce' },
  { label: '脉冲', value: 'pulse' },
  { label: '模糊显现', value: 'blur-in' },
  { label: '翻转', value: 'flip' },
  { label: '静止', value: 'none' },
];

const SUBTITLE_STYLE_CATEGORY_OPTIONS: { label: string; value: SubtitleStyleCategory }[] = [
  { label: '基础', value: 'basic' },
  { label: '气泡', value: 'bubble' },
  { label: '花字', value: 'fancy' },
];

const SUBTITLE_STYLE_OPTIONS: {
  label: string;
  value: SubtitleStylePreset;
  category: SubtitleStyleCategory;
  description: string;
  preview: string;
}[] = [
  { label: '经典字幕', value: 'caption-solid', category: 'basic', description: '稳妥通用，适合旁白和对白。', preview: '今天也要元气满满' },
  { label: '玻璃卡片', value: 'caption-glass', category: 'basic', description: '轻透面板，适合科技感画面。', preview: '镜头推进中' },
  { label: '描边字幕', value: 'caption-outline', category: 'basic', description: '弱背景也清晰，适合纪录片。', preview: '继续向前' },
  { label: '圆角气泡', value: 'bubble-rounded', category: 'bubble', description: '柔和圆角，适合日常聊天。', preview: '今天也很开心呀' },
  { label: '对话框', value: 'bubble-chat', category: 'bubble', description: '带尾巴的聊天框，适合人物说话。', preview: '这句台词在这里出现' },
  { label: '胶囊标签', value: 'bubble-pill', category: 'bubble', description: '短句强调，适合关键词。', preview: '夏天快乐' },
  { label: '云朵气泡', value: 'bubble-cloud', category: 'bubble', description: '更松软的对白框，适合可爱语气。', preview: '欢迎回来呀' },
  { label: '思考泡', value: 'bubble-thought', category: 'bubble', description: '适合内心 OS 或犹豫停顿。', preview: '嗯……这样行吗' },
  { label: '便签对白', value: 'bubble-note', category: 'bubble', description: '像漫画注释框，适合解释句。', preview: '这一句是补充说明' },
  { label: '喊话爆框', value: 'bubble-shout', category: 'bubble', description: '情绪更强，适合大声强调。', preview: '现在就出发' },
  { label: '低语黑泡', value: 'bubble-whisper', category: 'bubble', description: '压低氛围，适合神秘感。', preview: '别让别人听见' },
  { label: '高亮贴纸', value: 'highlight-tape', category: 'fancy', description: '像便签胶带，适合重点句。', preview: '本段重点信息' },
  { label: '糖果花字', value: 'sticker-pop', category: 'fancy', description: '明亮跳色，适合轻快内容。', preview: '元气值拉满' },
  { label: '漫画爆点', value: 'comic-burst', category: 'fancy', description: '适合强调爆点和情绪。', preview: '现在登场' },
];

const SUBTITLE_STYLE_MAP = Object.fromEntries(
  SUBTITLE_STYLE_OPTIONS.map((option) => [option.value, option]),
) as Record<SubtitleStylePreset, (typeof SUBTITLE_STYLE_OPTIONS)[number]>;

function normalizeSubtitleStylePreset(value: unknown): SubtitleStylePreset {
  return SUBTITLE_STYLE_OPTIONS.some((option) => option.value === value)
    ? (value as SubtitleStylePreset)
    : 'caption-solid';
}

function getSubtitleStyleCategory(value: SubtitleStylePreset): SubtitleStyleCategory {
  return SUBTITLE_STYLE_MAP[value]?.category || 'basic';
}

function formatSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function cuesToSrt(cues: SubtitleCue[]): string {
  return cues
    .map((cue, idx) => {
      const start = formatSrtTime(cue.start);
      const end = formatSrtTime(cue.end);
      return `${idx + 1}\n${start} --> ${end}\n${cue.text}\n`;
    })
    .join('\n');
}

function generateDefaultCue(videoDuration: number, start?: number): SubtitleCue {
  const s = typeof start === 'number' ? start : 0;
  const e = Math.min(s + 3, videoDuration || 10);
  return {
    start: s,
    end: e,
    text: '',
    vertical: 'bottom',
    align: 'center',
    x: 50,
    y: 88,
    animation: 'fade',
    stylePreset: 'caption-solid',
  };
}

function formatTimelineTime(seconds: number): string {
  const safe = Math.max(seconds || 0, 0);
  const minutes = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${secs.toFixed(1).padStart(4, '0')}`;
}

function clampCueTime(value: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  if (!Number.isFinite(maximum) || maximum <= 0) return Math.max(value, 0);
  return Math.min(Math.max(value, 0), maximum);
}

function clampCuePercent(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, 4), 96);
}

function positionToPercent(
  vertical: SubtitleCue['vertical'],
  align: SubtitleCue['align'],
): Pick<SubtitleCue, 'x' | 'y'> {
  const xMap: Record<SubtitleCue['align'], number> = { start: 14, center: 50, end: 86 };
  const yMap: Record<SubtitleCue['vertical'], number> = { top: 14, middle: 50, bottom: 88 };
  return { x: xMap[align], y: yMap[vertical] };
}

function percentToPosition(x: number, y: number): Pick<SubtitleCue, 'vertical' | 'align'> {
  const align: SubtitleCue['align'] = x < 33 ? 'start' : x > 67 ? 'end' : 'center';
  const vertical: SubtitleCue['vertical'] = y < 33 ? 'top' : y > 67 ? 'bottom' : 'middle';
  return { vertical, align };
}

function normalizeCue(cue: SubtitleCue, videoDuration: number): SubtitleCue {
  const safeDuration = Math.max(videoDuration || 0, 0.2);
  const start = clampCueTime(cue.start, safeDuration, 0);
  const endBase = clampCueTime(cue.end, safeDuration, Math.min(start + 2, safeDuration));
  const end = endBase <= start ? Math.min(safeDuration, start + 0.8) : endBase;
  const fallbackPosition = positionToPercent(cue.vertical || 'bottom', cue.align || 'center');
  return {
    ...cue,
    start: Number(start.toFixed(2)),
    end: Number(end.toFixed(2)),
    text: cue.text.trim(),
    x: Number(clampCuePercent(cue.x, fallbackPosition.x).toFixed(2)),
    y: Number(clampCuePercent(cue.y, fallbackPosition.y).toFixed(2)),
    stylePreset: normalizeSubtitleStylePreset(cue.stylePreset),
  };
}

function normalizeSubtitleCues(cues: SubtitleCue[], videoDuration: number): SubtitleCue[] {
  const safeDuration = Math.max(videoDuration || 0, 0.2);
  const normalized = cues
    .map((cue) => normalizeCue(cue, safeDuration))
    .filter((cue) => cue.text || cue.end > cue.start);

  let lastEnd = 0;
  return normalized
    .map((cue) => {
      const start = Math.max(cue.start, lastEnd);
      const end = Math.max(Math.min(cue.end, safeDuration), start + 0.2);
      if (end <= start) return null;
      lastEnd = end;
      return {
        ...cue,
        start: Number(start.toFixed(2)),
        end: Number(end.toFixed(2)),
      };
    })
    .filter((cue): cue is SubtitleCue => Boolean(cue));
}

function getSubtitleCueIssues(cues: SubtitleCue[], videoDuration: number): number {
  let issues = 0;
  let lastEnd = -1;
  for (const rawCue of cues) {
    const cue = normalizeCue(rawCue, videoDuration);
    if (!cue.text.trim()) issues += 1;
    if (cue.end <= cue.start) issues += 1;
    if (lastEnd >= 0 && cue.start < lastEnd) issues += 1;
    lastEnd = Math.max(lastEnd, cue.end);
  }
  return issues;
}

function getSubtitleEditorFallbackDuration(clip?: Clip | null): number {
  const estimated = Number(clip?.duration);
  if (Number.isFinite(estimated) && estimated > 0) return estimated;
  return 10;
}

function scopesToModalScope(scopes: ('story_analysis' | 'beat_frames')[]): EvaluationScope {
  return scopes.length >= 2 ? 'all' : scopes[0];
}

const STAGE_ORDER: Stage[] = ['input', 'clips', 'prompts', 'editing'];

function defaultStageForEpisode(ep: Episode | null): Stage {
  if (!ep) return 'input';
  switch (ep.status) {
    case 'edited':
    case 'editing':
    case 'video_ready':
    case 'complete':
      return 'editing';
    case 'images_ready':
      return 'prompts';
    case 'beat_prompts_ready':
    case 'storyboard_ready':
      return 'prompts';
    case 'analyzing':
    case 'analyzed':
      return 'clips';
    case 'draft':
    default:
      return 'input';
  }
}

/** 步骤条是否可进入该阶段（已生成数据或剧集状态已推进） */
function stageUnlocked(target: Stage, ep: Episode | null, clips: Clip[]): boolean {
  if (target === 'input') return true;
  if (!ep) return false;

  const hasPlan = clips.some(
    (c) => hasBeatStoryboardContent(c.storyboardPlan ?? undefined) || (c.panels?.length ?? 0) > 0,
  );
  const st = ep.status;

  if (target === 'clips') {
    return st !== 'draft' || clips.length > 0;
  }
  if (target === 'prompts') {
    return (
      hasPlan ||
      [
        'analyzing',
        'analyzed',
        'beat_prompts_ready',
        'storyboard_ready',
        'images_ready',
        'video_ready',
        'editing',
        'edited',
        'complete',
      ].includes(st)
    );
  }
  if (target === 'editing') {
    return (
      ['video_ready', 'editing', 'edited', 'complete'].includes(st) ||
      clips.some((c) => Boolean(c.videoUrl || c.editedVideoUrl))
    );
  }
  return false;
}

function isHttpUrl(value: string | null | undefined): boolean {
  return Boolean(value && /^https?:\/\//.test(value.trim()));
}

function isSupportedImageRef(value: string | null | undefined): boolean {
  if (!value) return false;
  const safe = value.trim();
  return /^https?:\/\//.test(safe) || safe.startsWith('data:image/');
}

function clipReadyForArkVideo(project: Project, clip: Clip): boolean {
  if (!hasBeatStoryboardContent(clip.storyboardPlan ?? undefined)) return true;
  if (!isSupportedImageRef(resolveVideoFirstFrameRef(clip.storyboardPlan?.first_frame))) return false;
  if (!(clip.storyboardPlan?.video_prompt || '').trim()) return false;
  if (clip.characters.some((name) => !isSupportedImageRef(effectiveCharacterRefUrl(project, clip, name)))) return false;
  const refs = clip.videoReferenceAssets || {};
  if ((refs.videoUrls || []).some((url) => !isHttpUrl(url))) return false;
  if ((refs.audioUrls || []).some((url) => !isHttpUrl(url))) return false;
  return true;
}

function collectArkVideoBlockers(project: Project, clips: Clip[]): string[] {
  return clips
    .filter((clip) => hasBeatStoryboardContent(clip.storyboardPlan ?? undefined))
    .flatMap((clip) => {
      const issues: string[] = [];
      if (!isSupportedImageRef(resolveVideoFirstFrameRef(clip.storyboardPlan?.first_frame))) issues.push(`情节 ${clip.clipIndex + 1} 缺首帧图片`);
      if (!(clip.storyboardPlan?.video_prompt || '').trim()) issues.push(`情节 ${clip.clipIndex + 1} 缺视频 Prompt`);
      const missingChars = clip.characters.filter((name) => !isSupportedImageRef(effectiveCharacterRefUrl(project, clip, name)));
      if (missingChars.length > 0) issues.push(`情节 ${clip.clipIndex + 1} 缺角色参考图：${missingChars.join('、')}`);
      const refs = clip.videoReferenceAssets || {};
      if ((refs.videoUrls || []).some((url) => !isHttpUrl(url))) issues.push(`情节 ${clip.clipIndex + 1} 存在非法参考视频 URL`);
      if ((refs.audioUrls || []).some((url) => !isHttpUrl(url))) issues.push(`情节 ${clip.clipIndex + 1} 存在非法参考音频 URL`);
      return issues;
    });
}

function isTerminalTaskStatus(s: Task['status']): boolean {
  return s === 'completed' || s === 'failed';
}

function isRunningTaskStatus(s: Task['status']): boolean {
  return !isTerminalTaskStatus(s);
}

const TASK_POLL_MS = 2500;
const NON_BLOCKING_TASK_TYPES = new Set<Task['type']>(['EXTRACT_VIDEO_FRAMES']);
export default function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const [project, setProject] = useState<Project | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [activeEpisode, setActiveEpisode] = useState<Episode | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [stage, setStage] = useState<Stage>('input');
  const [novelText, setNovelText] = useState('');
  const [loading, setLoading] = useState(true);
  const [tasks, setTasks] = useState<Record<string, Task>>({});
  const [storyboardMode, setStoryboardMode] = useState<StoryboardMode>('auto');
  const [showClassicStoryboard, setShowClassicStoryboard] = useState(false);
  const [error, setError] = useState('');
  const [editStrategy, setEditStrategy] = useState<'individual' | 'compile'>('compile');
  const [removeVocals, setRemoveVocals] = useState(false);
  const [editTransition, setEditTransition] = useState(0.5);
  const [subtitleMode, setSubtitleMode] = useState<'none' | 'auto' | 'custom' | 'timeline'>('none');
  const [subtitleText, setSubtitleText] = useState('');
  const [subtitlePosition, setSubtitlePosition] = useState<'top' | 'middle' | 'bottom'>('bottom');
  const [subtitleTargetClipId, setSubtitleTargetClipId] = useState<string | null>(null);
  const [editingPreviewTargetId, setEditingPreviewTargetId] = useState<string | null>(null);
  const [subtitleTimelineByClip, setSubtitleTimelineByClip] = useState<Record<string, SubtitleCue[]>>({});
  const [subtitleEditorOpen, setSubtitleEditorOpen] = useState(false);
  const [subtitleEditorClipId, setSubtitleEditorClipId] = useState<string | null>(null);
  const [subtitleEditorUrl, setSubtitleEditorUrl] = useState<string | null>(null);
  const [subtitleEditorDuration, setSubtitleEditorDuration] = useState(0);
  const [subtitleEditorDurationSource, setSubtitleEditorDurationSource] = useState<'estimated' | 'media'>('estimated');
  const [subtitleEditorCurrentTime, setSubtitleEditorCurrentTime] = useState(0);
  const [subtitlePreviewScrubbing, setSubtitlePreviewScrubbing] = useState(false);
  const [subtitleFrameTaskId, setSubtitleFrameTaskId] = useState<string | null>(null);
  const [subtitleFrames, setSubtitleFrames] = useState<{ timestamp: number; imageUrl: string }[]>([]);
  const [selectedCueIndex, setSelectedCueIndex] = useState<number | null>(null);
  const [subtitleStyleCategory, setSubtitleStyleCategory] = useState<SubtitleStyleCategory>('basic');
  const [subtitleInspectorTab, setSubtitleInspectorTab] = useState<SubtitleInspectorTab>('content');
  const [videoTaskIdsByClip, setVideoTaskIdsByClip] = useState<Record<string, string>>({});
  const [evaluationModal, setEvaluationModal] = useState<{ open: boolean; scope: EvaluationScope }>({
    open: false,
    scope: 'all',
  });

  const sseCleanup = useRef<(() => void) | null>(null);
  const activeEpisodeRef = useRef<Episode | null>(null);
  const pendingEvaluationScopeRef = useRef<EvaluationScope | null>(null);
  const handledEvaluationTasksRef = useRef(new Set<string>());
  const subtitlePreviewRef = useRef<HTMLVideoElement | null>(null);
  const subtitleRulerRef = useRef<HTMLDivElement | null>(null);
  const subtitlePreviewWrapRef = useRef<HTMLDivElement | null>(null);
  const subtitleRulerDraggingRef = useRef(false);
  const subtitleCueDragRef = useRef<{ cueIndex: number; edge: 'start' | 'end' } | null>(null);
  const subtitleOverlayDragRef = useRef<number | null>(null);
  activeEpisodeRef.current = activeEpisode;

  const refreshProjectData = useCallback(
    async (episodeId: string) => {
      if (!projectId) return;
      try {
        const [p, eps, cs] = await Promise.all([
          getProject(projectId),
          listEpisodes(projectId),
          listClips(projectId, episodeId),
        ]);
        setProject(p);
        setEpisodes(eps);
        setClips(cs);
        const nextEp = eps.find((e) => e.episodeId === episodeId);
        if (nextEp) setActiveEpisode(nextEp);
      } catch (e) {
        console.error(e);
      }
    },
    [projectId]
  );

  const mergeClipIntoState = useCallback((updated: Clip) => {
    setClips((prev) =>
      prev.map((c) =>
        c.clipId === updated.clipId ? { ...updated, panels: updated.panels ?? c.panels } : c,
      ),
    );
  }, []);

  const openEvaluationModal = useCallback((scope: EvaluationScope) => {
    setEvaluationModal({ open: true, scope });
  }, []);

  const closeEvaluationModal = useCallback(() => {
    setEvaluationModal((m) => ({ ...m, open: false }));
  }, []);

  const onEvaluationTaskDone = useCallback(() => {
    const scope = pendingEvaluationScopeRef.current ?? 'all';
    pendingEvaluationScopeRef.current = null;
    setEvaluationModal({ open: true, scope });
  }, []);

  const markEvaluationTaskHandled = useCallback(
    (taskId: string, taskType: Task['type'] | undefined, status: Task['status']) => {
      if (taskType !== 'EPISODE_EVALUATION' || status !== 'completed') return;
      if (handledEvaluationTasksRef.current.has(taskId)) return;
      handledEvaluationTasksRef.current.add(taskId);
      onEvaluationTaskDone();
    },
    [onEvaluationTaskDone],
  );

  // SSE 事件处理
  const handleSseEvent = useCallback(
    (event: SseEvent) => {
      if (event.type === 'task.progress') {
        setTasks((prev) => ({
          ...prev,
          [event.taskId]: {
            ...(prev[event.taskId] as Task),
            status: 'running',
            progress: event.progress,
            message: event.message,
          },
        }));
      } else if (event.type === 'task.completed') {
        setTasks((prev) => {
          const existing = prev[event.taskId] as Task | undefined;
          markEvaluationTaskHandled(event.taskId, existing?.type, 'completed');
          return {
            ...prev,
            [event.taskId]: { ...(existing as Task), status: 'completed', progress: 100 },
          };
        });
        const epId = activeEpisodeRef.current?.episodeId;
        if (projectId && epId) void refreshProjectData(epId);
      } else if (event.type === 'task.error') {
        setTasks((prev) => ({
          ...prev,
          [event.taskId]: {
            ...(prev[event.taskId] as Task),
            status: 'failed',
            error: event.error,
          },
        }));
      }
    },
    [projectId, refreshProjectData, markEvaluationTaskHandled]
  );

  // 初始化 SSE 连接
  useEffect(() => {
    sseCleanup.current = connectSSE(handleSseEvent);
    return () => sseCleanup.current?.();
  }, [handleSseEvent]);

  const nonTerminalTaskKey = Object.entries(tasks)
    .filter(([, t]) => isRunningTaskStatus(t.status))
    .map(([id]) => id)
    .sort()
    .join('|');

  // SSE 可能丢事件或未连接：轮询任务状态直到结束
  useEffect(() => {
    if (!nonTerminalTaskKey || !projectId) return;
    let cancelled = false;
    const taskIds = nonTerminalTaskKey.split('|').filter(Boolean);

    const tick = async () => {
      if (cancelled) return;
      for (const taskId of taskIds) {
        try {
          const t = await getTask(taskId);
          if (cancelled) return;
          setTasks((prev) => ({
            ...prev,
            [taskId]: { ...(prev[taskId] as Task), ...t },
          }));
          if (t.status === 'completed') {
            markEvaluationTaskHandled(taskId, t.type, t.status);
            const epId = t.episodeId ?? activeEpisodeRef.current?.episodeId;
            if (epId) void refreshProjectData(epId);
          }
        } catch (e) {
          console.error(e);
        }
      }
    };

    void tick();
    const iv = setInterval(tick, TASK_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [nonTerminalTaskKey, projectId, refreshProjectData, markEvaluationTaskHandled]);

  // 加载项目数据
  useEffect(() => {
    if (!projectId) return;
    Promise.all([getProject(projectId), listEpisodes(projectId)])
      .then(([proj, eps]) => {
        setProject(proj);
        setEpisodes(eps);
        if (eps.length > 0) {
          const ep = eps[0];
          setActiveEpisode(ep);
          setNovelText(ep.novelText);
          if (ep.status !== 'draft') {
            listClips(projectId, ep.episodeId).then(setClips);
            setStage(defaultStageForEpisode(ep));
          }
          if (ep.status === 'analyzing') {
            listTasks(projectId)
              .then((taskList) => {
                const latest = taskList.find(
                  (t) =>
                    t.type === 'STORY_ANALYSIS' &&
                    t.episodeId === ep.episodeId &&
                    isRunningTaskStatus(t.status)
                );
                if (latest) {
                  setTasks((prev) => ({
                    ...prev,
                    [latest.taskId]: { ...latest, episodeId: latest.episodeId ?? ep.episodeId },
                  }));
                }
              })
              .catch(console.error);
          }
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [projectId]);

  // 追踪正在运行的任务
  const addTask = useCallback((taskId: string, type: Task['type'], episodeId?: string | null) => {
    setTasks((prev) => ({
      ...prev,
      [taskId]: {
        taskId,
        type,
        status: 'pending',
        progress: 0,
        message: '等待开始...',
        error: null,
        result: null,
        episodeId: episodeId ?? undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    }));
  }, []);

  // 创建并分析剧集
  const handleAnalyze = async () => {
    if (!projectId || !novelText.trim()) { setError('请输入故事文本'); return; }
    setError('');
    try {
      let episode = activeEpisode;
      if (!episode) {
        episode = await createEpisode(projectId, { novelText });
        setActiveEpisode(episode);
        setEpisodes((prev) => [...prev, episode!]);
      }
      const taskId = await generateStory(projectId, episode.episodeId);
      addTask(taskId, 'STORY_ANALYSIS', episode.episodeId);
      setStage('clips');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '分析失败');
    }
  };

  // 主流程：视频 Prompt
  const handleGenerateBeatPrompts = async () => {
    if (!projectId || !activeEpisode) return;
    setError('');
    try {
      const taskId = await generateBeatPrompts(projectId, activeEpisode.episodeId);
      addTask(taskId, 'BEAT_PROMPT_GEN', activeEpisode.episodeId);
      setStage('prompts');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '生成失败');
    }
  };

  /** 高级：经典多分镜（与主流程二选一） */
  const handleClassicStoryboard = async () => {
    if (!projectId || !activeEpisode) return;
    setError('');
    try {
      const taskId = await generateStoryboard(projectId, activeEpisode.episodeId, {
        storyboardMode,
      });
      addTask(taskId, 'STORYBOARD_GEN', activeEpisode.episodeId);
      setStage('prompts');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '生成失败');
    }
  };

  // 生成图片
  const handleGenerateImages = async (panelIds?: string[]) => {
    if (!projectId || !activeEpisode || !project) return;
    setError('');
    const beatMode =
      !panelIds?.length &&
      clips.some((c) => hasBeatStoryboardContent(c.storyboardPlan ?? undefined));
    if (beatMode) {
      const weakScene = clips.some((c) => {
        const p = c.storyboardPlan;
        if (!hasBeatStoryboardContent(p ?? undefined)) return false;
        return !sceneRefReady(project, c);
      });
      if (
        weakScene &&
        !window.confirm(
          '部分情节尚未设置「场景」参考图（项目资产库或本段覆盖），首位帧容易漂移。是否仍继续生成首尾帧图片？',
        )
      ) {
        return;
      }
    }
    try {
      const taskId = await generateImages(projectId, activeEpisode.episodeId, panelIds);
      addTask(taskId, 'IMAGE_GENERATION', activeEpisode.episodeId);
      setStage('prompts');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '生成失败');
    }
  };

  const handleGenerateVideos = async (clipIds?: string[]) => {
    if (!projectId || !activeEpisode) return;
    setError('');
    try {
      const taskId = await generateVideos(projectId, activeEpisode.episodeId, clipIds);
      addTask(taskId, 'VIDEO_GENERATION', activeEpisode.episodeId);
      if (clipIds?.length === 1) {
        setVideoTaskIdsByClip((prev) => ({ ...prev, [clipIds[0]]: taskId }));
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '生成失败');
    }
  };

  const handleEditVideos = async () => {
    if (!projectId || !activeEpisode) return;
    setError('');
    const timelineByClip = Object.fromEntries(
      Object.entries(subtitleTimelineByClip)
        .map(([clipId, cues]) => [clipId, normalizeSubtitleCues(cues, clips.find((clip) => clip.clipId === clipId)?.duration || 10)])
        .filter(([, cues]) => cues.length > 0),
    );
    const clipIds =
      subtitleMode === 'timeline'
        ? Object.keys(timelineByClip)
        : readyBeatVideoClipIds.length > 0
          ? readyBeatVideoClipIds
          : undefined;
    const effectiveStrategy = subtitleMode === 'timeline' ? 'individual' : editStrategy;
    const finalSubtitleText = subtitleMode === 'custom' ? subtitleText.trim() : '';

    if (subtitleMode === 'timeline' && Object.keys(timelineByClip).length === 0) {
      setError('请至少为一个视频片段添加时间轴字幕');
      return;
    }

    try {
      const taskId = await editVideos(projectId, activeEpisode.episodeId, {
        clipIds,
        editOptions: {
          strategy: effectiveStrategy,
          removeVocals: removeVocals ? 'soft' : false,
          transitionDuration: editTransition,
          subtitles: {
            mode: subtitleMode,
            text: finalSubtitleText || undefined,
            position: subtitlePosition,
            timelineByClip: subtitleMode === 'timeline' ? timelineByClip : undefined,
          },
        },
      });
      addTask(taskId, 'VIDEO_EDITING', activeEpisode.episodeId);
      setStage('editing');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '剪辑失败');
    }
  };

  const openSubtitleEditor = (clip: Clip) => {
    if (!clip.videoUrl) return;
    setSubtitleTargetClipId(clip.clipId);
    setSubtitleEditorClipId(clip.clipId);
    setSubtitleEditorCurrentTime(0);
    setSubtitleEditorUrl(clip.videoUrl);
    setSubtitleEditorDuration(getSubtitleEditorFallbackDuration(clip));
    setSubtitleEditorDurationSource('estimated');
    setSubtitleFrames([]);
    setSelectedCueIndex(null);
    setSubtitleStyleCategory('basic');
    setSubtitleInspectorTab('content');
    setSubtitleEditorOpen(true);
    void startExtractFrames(clip.videoUrl);
  };

  const startExtractFrames = async (videoUrl: string) => {
    if (!projectId) return;
    setError('');
    try {
      const taskId = await extractVideoFrames(projectId, videoUrl, { maxFrames: 12, width: 320 });
      setSubtitleFrameTaskId(taskId);
      addTask(taskId, 'EXTRACT_VIDEO_FRAMES');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '抽帧失败');
    }
  };

  const addSubtitleCue = (timestamp?: number) => {
    if (!subtitleEditorClipId) return;
    setSubtitleTimelineByClip((prev) => {
      const next = [...(prev[subtitleEditorClipId] || []), generateDefaultCue(subtitleEditorDuration, timestamp)];
      setSelectedCueIndex(next.length - 1);
      return { ...prev, [subtitleEditorClipId]: next };
    });
  };

  const seekSubtitlePreview = useCallback((nextTime: number) => {
    const clampedTime = Math.max(0, Math.min(subtitleEditorDuration || 0, nextTime || 0));
    setSubtitleEditorCurrentTime(clampedTime);
    const preview = subtitlePreviewRef.current;
    if (!preview) return;
    try {
      preview.currentTime = clampedTime;
    } catch (error) {
      console.error(error);
    }
  }, [subtitleEditorDuration]);

  const seekSubtitlePreviewFromClientX = useCallback((clientX: number) => {
    const ruler = subtitleRulerRef.current;
    if (!ruler || subtitleEditorDuration <= 0) return;
    const rect = ruler.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = (clientX - rect.left) / rect.width;
    const nextTime = Math.max(0, Math.min(subtitleEditorDuration, pct * subtitleEditorDuration));
    seekSubtitlePreview(nextTime);
  }, [seekSubtitlePreview, subtitleEditorDuration]);

  const updateSubtitleCueEdgeFromClientX = useCallback((cueIndex: number, edge: 'start' | 'end', clientX: number) => {
    const ruler = subtitleRulerRef.current;
    if (!ruler || !subtitleEditorClipId || subtitleEditorDuration <= 0) return;
    const rect = ruler.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = (clientX - rect.left) / rect.width;
    const rawTime = Math.max(0, Math.min(subtitleEditorDuration, pct * subtitleEditorDuration));

    setSubtitleTimelineByClip((prev) => {
      const clipCues = prev[subtitleEditorClipId] || [];
      const nextCues = clipCues.map((cue, idx) => {
        if (idx !== cueIndex) return cue;
        const prevCue = clipCues[idx - 1];
        const nextCue = clipCues[idx + 1];
        if (edge === 'start') {
          const minStart = prevCue ? prevCue.end : 0;
          const maxStart = Math.max(minStart, cue.end - 0.2);
          const nextStart = Math.min(Math.max(rawTime, minStart), maxStart);
          return { ...cue, start: Number(nextStart.toFixed(2)) };
        }
        const minEnd = Math.min(subtitleEditorDuration, cue.start + 0.2);
        const maxEnd = nextCue ? nextCue.start : subtitleEditorDuration;
        const nextEnd = Math.max(minEnd, Math.min(rawTime, maxEnd));
        return { ...cue, end: Number(nextEnd.toFixed(2)) };
      });
      return { ...prev, [subtitleEditorClipId]: nextCues };
    });

    seekSubtitlePreview(rawTime);
  }, [seekSubtitlePreview, subtitleEditorClipId, subtitleEditorDuration]);

  const updateSubtitleCuePositionFromClientPoint = useCallback((cueIndex: number, clientX: number, clientY: number) => {
    const wrap = subtitlePreviewWrapRef.current;
    if (!wrap || !subtitleEditorClipId) return;
    const rect = wrap.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;
    const next = percentToPosition(x, y);
    setSubtitleTimelineByClip((prev) => ({
      ...prev,
      [subtitleEditorClipId]: (prev[subtitleEditorClipId] || []).map((cue, idx) => (
        idx === cueIndex
          ? {
              ...cue,
              x: Number(clampCuePercent(x, cue.x).toFixed(2)),
              y: Number(clampCuePercent(y, cue.y).toFixed(2)),
              vertical: next.vertical,
              align: next.align,
            }
          : cue
      )),
    }));
  }, [subtitleEditorClipId]);

  const updateSubtitleCue = (index: number, patch: Partial<SubtitleCue>) => {
    if (!subtitleEditorClipId) return;
    setSubtitleTimelineByClip((prev) => ({
      ...prev,
      [subtitleEditorClipId]: (prev[subtitleEditorClipId] || []).map((cue, i) => {
        if (i !== index) return cue;
        const nextCue = { ...cue, ...patch };
        if (patch.vertical !== undefined || patch.align !== undefined) {
          const nextPosition = positionToPercent(nextCue.vertical, nextCue.align);
          nextCue.x = nextPosition.x;
          nextCue.y = nextPosition.y;
        }
        return nextCue;
      }),
    }));
  };

  const removeSubtitleCue = (index: number) => {
    if (!subtitleEditorClipId) return;
    setSubtitleTimelineByClip((prev) => ({
      ...prev,
      [subtitleEditorClipId]: (prev[subtitleEditorClipId] || []).filter((_, i) => i !== index),
    }));
    if (selectedCueIndex === index) setSelectedCueIndex(null);
    else if (selectedCueIndex !== null && selectedCueIndex > index) setSelectedCueIndex(selectedCueIndex - 1);
  };

  const normalizeCurrentSubtitleCues = () => {
    if (!subtitleEditorClipId) return;
    setSubtitleTimelineByClip((prev) => ({
      ...prev,
      [subtitleEditorClipId]: normalizeSubtitleCues(prev[subtitleEditorClipId] || [], subtitleEditorDuration),
    }));
  };

  const closeSubtitleEditor = () => {
    setSubtitleEditorOpen(false);
    setSubtitleEditorClipId(null);
    setSubtitleEditorUrl(null);
    setSubtitleEditorCurrentTime(0);
    setSubtitlePreviewScrubbing(false);
    setSubtitleEditorDurationSource('estimated');
    setSubtitleFrameTaskId(null);
  };

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (subtitleOverlayDragRef.current !== null) {
        updateSubtitleCuePositionFromClientPoint(subtitleOverlayDragRef.current, event.clientX, event.clientY);
        return;
      }
      if (subtitleCueDragRef.current) {
        const { cueIndex, edge } = subtitleCueDragRef.current;
        updateSubtitleCueEdgeFromClientX(cueIndex, edge, event.clientX);
        return;
      }
      if (!subtitleRulerDraggingRef.current) return;
      seekSubtitlePreviewFromClientX(event.clientX);
    };
    const handlePointerUp = () => {
      subtitleRulerDraggingRef.current = false;
      subtitleCueDragRef.current = null;
      subtitleOverlayDragRef.current = null;
      setSubtitlePreviewScrubbing(false);
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [seekSubtitlePreviewFromClientX, updateSubtitleCueEdgeFromClientX, updateSubtitleCuePositionFromClientPoint]);

  // 处理抽帧任务结果
  useEffect(() => {
    if (subtitleFrameTaskId && tasks[subtitleFrameTaskId]?.status === 'completed') {
      const result = tasks[subtitleFrameTaskId].result as { frames?: { timestamp: number; imageUrl: string }[]; duration?: number } | undefined;
      if (result?.frames) setSubtitleFrames(result.frames);
      if (result?.duration) setSubtitleEditorDuration(result.duration);
      setSubtitleFrameTaskId(null);
    }
  }, [tasks, subtitleFrameTaskId]);

  const handleEvaluate = async (scopes: ('story_analysis' | 'beat_frames')[]) => {
    if (!projectId || !activeEpisode) return;
    setError('');
    const modalScope = scopesToModalScope(scopes);
    pendingEvaluationScopeRef.current = modalScope;
    setEvaluationModal((m) => ({ ...m, scope: modalScope }));
    try {
      const taskId = await evaluateEpisode(projectId, activeEpisode.episodeId, scopes);
      addTask(taskId, 'EPISODE_EVALUATION', activeEpisode.episodeId);
    } catch (e: unknown) {
      pendingEvaluationScopeRef.current = null;
      setError(e instanceof Error ? e.message : '评估失败');
    }
  };

  const goToStage = useCallback(
    (target: Stage) => {
      if (!stageUnlocked(target, activeEpisode, clips)) return;
      const epId = activeEpisode?.episodeId;
      if (epId && projectId) void refreshProjectData(epId);
      setStage(target);
    },
    [activeEpisode, clips, projectId, refreshProjectData],
  );

  const subtitleVideoClips = clips.filter((clip) => Boolean(clip.videoUrl));
  const previewableVideoClips = clips.filter((clip) => Boolean(clip.editedVideoUrl || clip.videoUrl));
  const subtitleEditorCues = subtitleEditorClipId ? (subtitleTimelineByClip[subtitleEditorClipId] || []) : [];

  useEffect(() => {
    if (subtitleVideoClips.length === 0) {
      if (subtitleTargetClipId !== null) setSubtitleTargetClipId(null);
      return;
    }
    if (!subtitleTargetClipId || !subtitleVideoClips.some((clip) => clip.clipId === subtitleTargetClipId)) {
      setSubtitleTargetClipId(subtitleVideoClips[0].clipId);
    }
  }, [subtitleTargetClipId, subtitleVideoClips]);

  useEffect(() => {
    if (subtitleMode === 'timeline' && subtitleTargetClipId && previewableVideoClips.some((clip) => clip.clipId === subtitleTargetClipId)) {
      if (editingPreviewTargetId !== subtitleTargetClipId) setEditingPreviewTargetId(subtitleTargetClipId);
      return;
    }
    if (previewableVideoClips.length === 0) {
      if (editingPreviewTargetId !== null) setEditingPreviewTargetId(null);
      return;
    }
    const isCurrentClipValid =
      editingPreviewTargetId !== null
      && previewableVideoClips.some((clip) => clip.clipId === editingPreviewTargetId);
    if (isCurrentClipValid) return;
    const preferredClipId =
      subtitleTargetClipId && previewableVideoClips.some((clip) => clip.clipId === subtitleTargetClipId)
        ? subtitleTargetClipId
        : previewableVideoClips[0].clipId;
    setEditingPreviewTargetId(preferredClipId);
  }, [
    editingPreviewTargetId,
    previewableVideoClips,
    subtitleMode,
    subtitleTargetClipId,
  ]);

  useEffect(() => {
    if (selectedCueIndex === null) return;
    const cue = subtitleEditorCues[selectedCueIndex];
    if (!cue) return;
    setSubtitleStyleCategory(getSubtitleStyleCategory(normalizeSubtitleStylePreset(cue.stylePreset)));
  }, [selectedCueIndex, subtitleEditorCues]);

  const allRunningTasks = Object.values(tasks).filter((t) => isRunningTaskStatus(t.status));
  const runningTasks = allRunningTasks.filter((t) => !NON_BLOCKING_TASK_TYPES.has(t.type));
  const backgroundSubtitleTaskCount = allRunningTasks.length - runningTasks.length;

  if (loading) return <div className="loading-full">加载中...</div>;
  if (!project) return <div className="loading-full">项目不存在</div>;

  const allPanels = clips.flatMap((c) => c.panels || []);
  const hasBeatStoryboard = clips.some((c) => hasBeatStoryboardContent(c.storyboardPlan ?? undefined));
  const arkVideoBlockers = project ? collectArkVideoBlockers(project, clips) : [];
  const readyBeatVideoClipIds = project
    ? clips
      .filter((c) => hasBeatStoryboardContent(c.storyboardPlan ?? undefined))
      .filter((clip) => clipReadyForArkVideo(project, clip))
      .map((clip) => clip.clipId)
    : [];
  const hasReadyBeatVideoClips = readyBeatVideoClipIds.length > 0;
  const hasStoryboardVisualPlan = allPanels.length > 0 || hasBeatStoryboard;
  const hasEditReadyClips = clips.some((c) => Boolean(c.videoUrl));
  const clipsEvalScope: EvaluationScope = 'story_analysis';
  const promptsEvalScope: EvaluationScope = hasEvaluationForScope(activeEpisode?.evaluation, 'all')
    ? 'all'
    : 'beat_frames';
  const subtitleTargetClip = subtitleVideoClips.find((clip) => clip.clipId === subtitleTargetClipId) || subtitleVideoClips[0] || null;
  const normalizedSubtitleEditorCues = normalizeSubtitleCues(subtitleEditorCues, subtitleEditorDuration);
  const subtitleEditorIssues = getSubtitleCueIssues(subtitleEditorCues, subtitleEditorDuration);
  const activePreviewCues = normalizedSubtitleEditorCues
    .map((cue, index) => ({ cue, index }))
    .filter(({ cue }) => subtitleEditorCurrentTime >= cue.start && subtitleEditorCurrentTime <= cue.end);
  const activeSubtitleFrame =
    subtitleFrames.length > 0
      ? subtitleFrames.reduce((closest, frame) => {
          if (!closest) return frame;
          return Math.abs(frame.timestamp - subtitleEditorCurrentTime) < Math.abs(closest.timestamp - subtitleEditorCurrentTime)
            ? frame
            : closest;
        }, subtitleFrames[0])
      : null;
  const timelineSubtitleClipCount = Object.values(subtitleTimelineByClip).filter((cues) => cues.length > 0).length;
  const timelineSubtitleCueCount = Object.values(subtitleTimelineByClip).reduce((sum, cues) => sum + cues.length, 0);
  const shouldShowCompiledPreview = subtitleMode !== 'timeline' && Boolean(activeEpisode?.compiledVideoUrl);
  const compiledPreviewUrl = shouldShowCompiledPreview ? activeEpisode?.compiledVideoUrl ?? undefined : undefined;
  const compiledSubtitleUrl = shouldShowCompiledPreview ? activeEpisode?.subtitleUrl ?? undefined : undefined;
  const editingPreviewClip =
    editingPreviewTargetId
      ? previewableVideoClips.find((clip) => clip.clipId === editingPreviewTargetId) || null
      : null;
  const editingPreviewUrl = editingPreviewClip?.editedVideoUrl || editingPreviewClip?.videoUrl || null;
  const editingPreviewSubtitleUrl = editingPreviewClip?.subtitleUrl || null;
  const editingPreviewTitle = subtitleMode === 'timeline' && editingPreviewClip
      ? `情节 ${editingPreviewClip.clipIndex + 1} 时间轴预览`
    : editingPreviewClip
      ? `当前剪辑预览 · 情节 ${editingPreviewClip.clipIndex + 1}`
      : '当前剪辑预览';
  const editingPreviewSummary =
    editingPreviewClip
      ? editingPreviewClip.summary
      : hasEditReadyClips
        ? '可预览素材准备中。'
        : '暂无可预览视频。';
  const editingPreviewHint =
    subtitleMode === 'timeline'
      ? '当前预览跟随时间轴编辑片段，便于校准字幕位置、节奏与文字动画。'
      : editStrategy === 'compile'
        ? '左侧固定显示当前情节片段；完整成片只在底部输出区查看。'
        : '左侧主预览聚焦当前情节，便于先检查素材，再查看剪辑结果。';

  const reevaluateForModalScope = () => {
    const scopes =
      evaluationModal.scope === 'beat_frames'
        ? (['beat_frames'] as const)
        : evaluationModal.scope === 'story_analysis'
          ? (['story_analysis'] as const)
          : (['story_analysis', 'beat_frames'] as const);
    void handleEvaluate([...scopes]);
  };

  return (
    <div className="project-page">
      {/* 顶部导航 */}
      <header className="project-header">
        <button className="btn-back" onClick={() => navigate('/')}>← 返回</button>
        <div className="project-title-area">
          <h1 className="project-title">{project.name}</h1>
          <span className="art-tag">{project.artStyle} · {project.videoRatio}</span>
        </div>
        <div className="header-actions">
          {allRunningTasks.length > 0 && (
            <span className="task-indicator">
              ⏳ {allRunningTasks.length} 个任务运行中
              {backgroundSubtitleTaskCount > 0 ? `（含 ${backgroundSubtitleTaskCount} 个字幕辅助任务）` : ''}
            </span>
          )}
        </div>
      </header>

      {error && <div className="error-banner">{error}<button onClick={() => setError('')}>×</button></div>}

      {/* 进度步骤条：可点击切换（仅已解锁阶段） */}
      <div className="stage-bar">
        {STAGE_ORDER.map((s, i) => {
          const unlocked = stageUnlocked(s, activeEpisode, clips);
          const curIdx = STAGE_ORDER.indexOf(stage);
          return (
            <button
              type="button"
              key={s}
              className={`stage-step stage-step-nav ${stage === s ? 'active' : ''} ${curIdx > i ? 'done' : ''} ${unlocked ? '' : 'locked'}`}
              disabled={!unlocked}
              title={unlocked ? `切换到：${s}` : '请先完成前置步骤'}
              onClick={() => goToStage(s)}
            >
              <span className="step-num">{i + 1}</span>
              <span className="step-label">
                {
                  {
                    input: '输入文本',
                    clips: '情节分析',
                    prompts: '视频 Prompt',
                    editing: '视频剪辑',
                  }[s]
                }
              </span>
            </button>
          );
        })}
      </div>

      {/* 运行中任务进度 */}
      {runningTasks.map((t) => (
        <div key={t.taskId} className="task-progress-bar">
          <div className="task-info">
            <span className="task-type">
              {
                {
                  STORY_ANALYSIS: '故事分析',
                  BEAT_PROMPT_GEN: '视频 Prompt',
                  STORYBOARD_GEN: '经典分镜',
                  IMAGE_GENERATION: '图片生成',
                  VIDEO_GENERATION: '视频生成',
                  VIDEO_EDITING: '生成最终视频',
                  EPISODE_EVALUATION: '质量评估',
                  EXTRACT_VIDEO_FRAMES: '视频抽帧',
                  PARSE_SUBTITLE_LANGUAGE: '解析字幕',
                }[t.type]
              }
            </span>
            <span className="task-msg">{t.message}</span>
            <span className="task-pct">{t.progress}%</span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${t.progress}%` }} />
          </div>
        </div>
      ))}

      <div className="project-content">
        {/* ── 阶段1: 输入文本 ── */}
        {stage === 'input' && (
          <div className="stage-panel">
            <h2>输入故事文本</h2>
            <p className="stage-hint">粘贴小说章节或故事文本，AI 将自动分析角色、场景和情节结构</p>
            <textarea
              className="novel-textarea"
              placeholder="在此粘贴故事文本...（建议 500-3000 字）"
              value={novelText}
              onChange={(e) => setNovelText(e.target.value)}
              rows={16}
            />
            <div className="word-count">{novelText.length} 字</div>
            <div className="stage-actions">
              <button
                className="btn-primary btn-large"
                onClick={handleAnalyze}
                disabled={!novelText.trim() || runningTasks.length > 0}
              >
                {runningTasks.length > 0 ? '分析中...' : '🤖 开始 AI 分析'}
              </button>
            </div>
          </div>
        )}

        {/* ── 阶段2: 情节片段 ── */}
        {stage === 'clips' && (
          <div className="stage-panel">
            <div className="stage-header">
              <h2>情节分析结果</h2>
              <div className="header-actions">
                <button className="btn-ghost" onClick={() => goToStage('input')}>← 重新输入</button>
                {clips.length > 0 && (
                  <button
                    className="btn-primary"
                    onClick={handleGenerateBeatPrompts}
                    disabled={runningTasks.length > 0}
                  >
                    {runningTasks.length > 0 ? '生成中...' : '📝 生成视频 Prompt'}
                  </button>
                )}
                {clips.length > 0 && (
                  <button
                    className="btn-ghost"
                    onClick={() => handleEvaluate(['story_analysis'])}
                    disabled={runningTasks.length > 0}
                  >
                    🔍 评估情节分析
                  </button>
                )}
                <EvaluationScoreBadge
                  evaluation={activeEpisode?.evaluation}
                  scope={clipsEvalScope}
                  onOpen={() => openEvaluationModal(clipsEvalScope)}
                />
                {hasStoryboardVisualPlan && (
                  <button type="button" className="btn-ghost" onClick={() => goToStage('prompts')}>
                    查看视频 Prompt →
                  </button>
                )}
              </div>
            </div>
            {clips.length > 0 && (
              <div className="advanced-storyboard-box">
                <button
                  type="button"
                  className="btn-ghost btn-small"
                  onClick={() => setShowClassicStoryboard((v) => !v)}
                >
                  {showClassicStoryboard ? '▼ 收起高级选项' : '▶ 高级：经典多分镜'}
                </button>
                {showClassicStoryboard && (
                  <div className="classic-storyboard-row">
                    <label className="mode-label">
                      分镜策略
                      <select
                        className="mode-select"
                        value={storyboardMode}
                        onChange={(e) => setStoryboardMode(e.target.value as StoryboardMode)}
                      >
                        <option value="auto">自动（复杂情节 → 多分镜）</option>
                        <option value="beat_frames">仅首尾关键帧（与主流程类似）</option>
                        <option value="panels">经典多分镜</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={handleClassicStoryboard}
                      disabled={runningTasks.length > 0}
                    >
                      {runningTasks.length > 0 ? '…' : '🎬 走经典分镜流程'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {runningTasks.length > 0 && clips.length === 0 ? (
              <div className="analyzing-state">
                <div className="spinner" />
                <p>AI 正在分析故事结构...</p>
              </div>
            ) : clips.length === 0 ? (
              <p className="empty-hint">暂无情节片段，请等待分析完成或重新分析</p>
            ) : (
              <>
                {/* 角色和场景概览 */}
                {project.characters.length > 0 && (
                  <div className="info-cards">
                    <div className="info-card">
                      <h3>👤 角色 ({project.characters.length})</h3>
                      <div className="tag-list">
                        {project.characters.map((c) => (
                          <span key={c.name} className={`char-tag ${c.role}`}>{c.name}</span>
                        ))}
                      </div>
                    </div>
                    <div className="info-card">
                      <h3>📍 场景 ({project.locations.length})</h3>
                      <div className="tag-list">
                        {project.locations.map((l) => (
                          <span key={l.name} className="loc-tag">{l.name}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* 情节片段列表 */}
                <div className="clips-list">
                  {clips.length > 0 && clips.some(c => c.duration) && (
                    <div className="clips-total-duration">
                      总时长预估：{clips.reduce((sum, c) => sum + (c.duration || 0), 0)}s
                    </div>
                  )}
                  {clips.map((clip) => (
                    <div key={clip.clipId} className="clip-card">
                      <div className="clip-header">
                        <span className="clip-num">情节 {clip.clipIndex + 1}</span>
                        <span className="clip-location">📍 {clip.location}</span>
                        <span className={`clip-mood mood-${clip.mood}`}>{clip.mood}</span>
                        {clip.duration && (
                          <span className="clip-duration">⏱ {clip.duration}s</span>
                        )}
                        {clip.sceneComplexity === 'complex' && (
                          <span className="clip-complexity" title="在「高级：经典多分镜」中可走多分镜">
                            复杂镜头
                          </span>
                        )}
                      </div>
                      <p className="clip-summary">{clip.summary}</p>
                      <div className="clip-chars">
                        {clip.characters.map((c) => <span key={c} className="char-chip">{c}</span>)}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── 阶段3: 视频 Prompt（LLM 文案 + 直接生视频）── */}
        {stage === 'prompts' && (
          <div className="stage-panel">
            <div className="stage-header">
              <h2>视频 Prompt</h2>
              <div className="header-actions">
                <button className="btn-ghost" onClick={() => goToStage('clips')}>← 返回情节</button>
                {hasBeatStoryboard && (
                  <button
                    className="btn-primary"
                    onClick={() => handleGenerateVideos(readyBeatVideoClipIds)}
                    disabled={runningTasks.length > 0 || !hasReadyBeatVideoClips}
                  >
                    {runningTasks.length > 0 ? '生成中...' : '🎬 生成视频'}
                  </button>
                )}
                {hasBeatStoryboard && (
                  <button
                    className="btn-ghost"
                    onClick={() => handleEvaluate(['beat_frames'])}
                    disabled={runningTasks.length > 0}
                  >
                    🔍 评估视频 Prompt
                  </button>
                )}
                {clips.length > 0 && hasBeatStoryboard && (
                  <button
                    className="btn-ghost"
                    onClick={() => handleEvaluate(['story_analysis', 'beat_frames'])}
                    disabled={runningTasks.length > 0}
                  >
                    🔍 整体评估
                  </button>
                )}
                <EvaluationScoreBadge
                  evaluation={activeEpisode?.evaluation}
                  scope={promptsEvalScope}
                  onOpen={() => openEvaluationModal(promptsEvalScope)}
                />
                {hasEditReadyClips && (
                  <button className="btn-ghost" onClick={() => goToStage('editing')}>
                    进入视频剪辑 →
                  </button>
                )}
              </div>
            </div>
            <p className="stage-hint">
              视觉资产库中，<strong>角色形象参考图必须为竖屏 {CHARACTER_REFERENCE_RATIO}</strong>（AI 生成与本地上传均遵守）；场景参考图比例跟随项目视频设置。当前流程会保留首帧 Prompt 和首帧图片生成，并直接使用首帧图、视频 Prompt 与参考图生成视频。生成后的原始视频可直接在各情节卡片内播放，不再单独拆出“视频预览”阶段。
            </p>
            {hasBeatStoryboard && arkVideoBlockers.length > 0 ? (
              <p className="empty-hint">
                {hasReadyBeatVideoClips
                  ? `可先生成已就绪情节；未就绪项示例：${arkVideoBlockers[0]}`
                  : (arkVideoBlockers[0] || '请先补齐首帧图片、角色参考图和合法参考素材 URL，再生成视频。')}
              </p>
            ) : null}

            {runningTasks.length > 0 && !hasStoryboardVisualPlan ? (
              <div className="analyzing-state">
                <div className="spinner" />
                <p>AI 正在生成视频结构化 Prompt…</p>
              </div>
            ) : !hasStoryboardVisualPlan ? (
              <p className="empty-hint">请先在情节页点击「生成视频 Prompt」或使用高级经典分镜</p>
            ) : (
              <div className="storyboard-grid prompts-stage-layout">
                {project && (project.characters.length > 0 || project.locations.length > 0) ? (
                  <VisualAssetLibrary
                    project={project}
                    projectId={projectId!}
                    episodeId={activeEpisode?.episodeId}
                    clips={clips}
                    disabled={runningTasks.length > 0}
                    onProjectUpdated={(p) => setProject(p)}
                    onError={(msg) => setError(msg)}
                  />
                ) : null}
                {clips.map((clip) => {
                  const plan = clip.storyboardPlan;
                  if (
                    plan &&
                    hasBeatStoryboardContent(plan) &&
                    project &&
                    activeEpisode
                  ) {
                    return (
                      <div key={clip.clipId} className="clip-section beat-section">
                        <h3 className="clip-section-title">
                          情节 {clip.clipIndex + 1}: {clip.summary}
                          <span className="beat-badge">视频链路</span>
                          {clip.duration && (
                            <span className="clip-duration">⏱ {clip.duration}s</span>
                          )}
                        </h3>
                        <BeatKeyframeEditor
                          clip={clip}
                          project={project}
                          projectId={projectId!}
                          episodeId={activeEpisode.episodeId}
                          plan={storyboardPlanForDisplay(plan)}
                          disabled={runningTasks.length > 0}
                          onClipUpdated={mergeClipIntoState}
                          onTaskCreated={(taskId, type) => addTask(taskId, type, activeEpisode.episodeId)}
                          onGenerateVideo={(clipId) => handleGenerateVideos([clipId])}
                          onError={(msg) => setError(msg)}
                          videoGenerationTask={(() => {
                            const taskId = videoTaskIdsByClip[clip.clipId];
                            if (!taskId) return null;
                            const t = tasks[taskId];
                            if (!t) return { taskId, progress: 0, message: '等待开始...', status: 'pending' };
                            return {
                              taskId,
                              progress: t.progress ?? 0,
                              message: t.message || '',
                              status: t.status === 'pending' ? 'running' : t.status,
                            };
                          })()}
                        />
                      </div>
                    );
                  }
                  if ((clip.panels || []).length === 0) return null;
                  return (
                    <div key={clip.clipId} className="clip-section">
                      <h3 className="clip-section-title">
                        情节 {clip.clipIndex + 1}: {clip.summary}
                        <span className="beat-badge multi-badge">多分镜</span>
                      </h3>
                      <div className="panels-row">
                        {(clip.panels || []).map((panel) => (
                          <div key={panel.panelId} className="panel-card">
                            {panel.imageUrl ? (
                              <img src={panel.imageUrl} alt={panel.description} className="panel-img" />
                            ) : (
                              <div className="panel-placeholder">
                                <span className="shot-label">{panel.shotType}</span>
                              </div>
                            )}
                            <div className="panel-info">
                              <p className="panel-desc">{panel.description}</p>
                              <div className="panel-meta">
                                <span>{panel.shotType}</span>
                                <span className={`mood-dot mood-${panel.mood}`} />
                              </div>
                              {panel.dialogue && (
                                <p className="panel-dialogue">「{panel.dialogue}」</p>
                              )}
                            </div>
                            {!panel.imageUrl && (
                              <button
                                className="btn-gen-img"
                                onClick={() => handleGenerateImages([panel.panelId])}
                                disabled={runningTasks.length > 0}
                              >
                                生成图片
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── 阶段4: 视频剪辑 ── */}
        {stage === 'editing' && (
          <div className="stage-panel">
            <div className="stage-header">
              <h2>视频剪辑</h2>
              <div className="header-actions">
                <button className="btn-ghost" onClick={() => goToStage('prompts')}>← 返回视频 Prompt</button>
              </div>
            </div>
            <p className="stage-hint">
              这里处理视频合并、逐情节剪辑、去人声、过渡与字幕；下方会展示对应的最终视频结果。
            </p>
            <div className="editing-studio-layout">
              <section className="editing-preview-panel">
                <div className="editing-preview-head">
                  <div>
                    <p className="subtitle-panel-kicker">Preview Canvas</p>
                    <h3>{editingPreviewTitle}</h3>
                    <p className="compiled-video-hint">{editingPreviewHint}</p>
                  </div>
                  <div className="subtitle-pill-row">
                    {editingPreviewClip?.editedVideoUrl ? (
                      <span className="subtitle-stat-pill is-ok">已剪辑片段</span>
                    ) : editingPreviewClip ? (
                      <span className="subtitle-stat-pill">原始片段</span>
                    ) : null}
                    {editingPreviewClip?.duration ? (
                      <span className="subtitle-stat-pill">{editingPreviewClip.duration}s</span>
                    ) : null}
                    {subtitleMode === 'timeline' && editingPreviewClip ? (
                      <span className={`subtitle-stat-pill ${(subtitleTimelineByClip[editingPreviewClip.clipId] || []).length > 0 ? 'is-ok' : ''}`}>
                        {(subtitleTimelineByClip[editingPreviewClip.clipId] || []).length} 条字幕
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="editing-preview-summary">
                  <strong>
                    {editingPreviewClip?.editedVideoUrl
                      ? `已剪辑 · 情节 ${editingPreviewClip.clipIndex + 1}`
                      : editingPreviewClip
                        ? `待剪辑 · 情节 ${editingPreviewClip.clipIndex + 1}`
                        : '等待素材'}
                  </strong>
                  <span>{editingPreviewSummary}</span>
                </div>

                {editingPreviewUrl ? (
                  <div className="editing-preview-player-wrap">
                    <video controls className="editing-preview-video" playsInline>
                      <source src={editingPreviewUrl} />
                      {editingPreviewSubtitleUrl ? (
                        <track kind="captions" src={editingPreviewSubtitleUrl} srcLang="zh" label="中文字幕" default />
                      ) : null}
                    </video>
                  </div>
                ) : (
                  <p className="empty-hint">
                    {hasEditReadyClips
                      ? '暂无可预览结果。点击「开始剪辑」后，这里会先展示当前情节的片段结果。'
                      : '暂无可编辑视频。请先生成视频。'}
                  </p>
                )}

              </section>

              <aside className="edit-options-panel edit-options-panel--rich editing-controls-sidebar">
                <div className="subtitle-panel-head">
                  <div>
                    <p className="subtitle-panel-kicker">Post Edit Suite</p>
                    <h3>剪辑与字幕工作台</h3>
                  </div>
                  <div className="subtitle-pill-row">
                    <span className="subtitle-stat-pill">{subtitleVideoClips.length} 段素材</span>
                    <span className="subtitle-stat-pill">{timelineSubtitleCueCount} 条时间轴字幕</span>
                  </div>
                </div>

                <div className="edit-options-grid">
                  <div className="edit-option-card">
                    <label className="edit-label">
                      剪辑策略
                      <select
                        className="edit-select"
                        value={editStrategy}
                        onChange={(e) => setEditStrategy(e.target.value as 'individual' | 'compile')}
                        disabled={runningTasks.length > 0 || subtitleMode === 'timeline'}
                      >
                        <option value="individual">单独编辑各情节</option>
                        <option value="compile">全集拼接（推荐）</option>
                      </select>
                    </label>
                    <p className="edit-helper-text">
                      {subtitleMode === 'timeline'
                        ? '时间轴字幕需要逐片段精修，已自动锁定为单独编辑。'
                        : '全集拼接适合一键成片；逐情节编辑更适合细调字幕与节奏。'}
                    </p>
                  </div>

                  <div className="edit-option-card">
                    <label className="edit-label edit-toggle-label">
                      <input
                        type="checkbox"
                        checked={removeVocals}
                        onChange={(e) => setRemoveVocals(e.target.checked)}
                        disabled={runningTasks.length > 0}
                      />
                      <span>去人声处理（保留背景音乐）</span>
                    </label>
                    <p className="edit-helper-text">适合需要后续重新配音或外挂旁白的素材。</p>
                  </div>

                  {editStrategy === 'compile' && subtitleMode !== 'timeline' && (
                    <div className="edit-option-card">
                      <label className="edit-label">
                        过渡时长（秒）
                        <input
                          type="number"
                          min="0.1"
                          max="2"
                          step="0.1"
                          value={editTransition}
                          onChange={(e) => setEditTransition(parseFloat(e.target.value))}
                          disabled={runningTasks.length > 0}
                          className="edit-number-input"
                        />
                      </label>
                      <p className="edit-helper-text">拼接模式下会在片段连接处加入淡化过渡。</p>
                    </div>
                  )}

                  <div className="edit-option-card">
                    <label className="edit-label">
                      字幕模式
                      <select
                        className="edit-select"
                        value={subtitleMode}
                        onChange={(e) => {
                          const nextMode = e.target.value as 'none' | 'auto' | 'custom' | 'timeline';
                          setSubtitleMode(nextMode);
                          if (nextMode === 'timeline') setEditStrategy('individual');
                        }}
                        disabled={runningTasks.length > 0}
                      >
                        <option value="none">无字幕</option>
                        <option value="auto">自动生成（按文案分配）</option>
                        <option value="custom">自定义文本</option>
                        <option value="timeline">时间轴编辑（逐片段）</option>
                      </select>
                    </label>
                    <p className="edit-helper-text">
                      时间轴模式会导出 WebVTT，并保留每条字幕的上下位置与左右对齐。
                    </p>
                  </div>
                </div>

                {subtitleMode === 'timeline' && (
                  <div className="subtitle-workbench-card">
                    <div className="subtitle-workbench-head">
                      <div>
                        <h4>时间轴字幕</h4>
                        <p>按片段分别编辑字幕节奏、位置和预览动画。</p>
                      </div>
                      <div className="subtitle-pill-row">
                        <span className="subtitle-stat-pill">{timelineSubtitleClipCount}/{subtitleVideoClips.length} 段已配置</span>
                        <span className={`subtitle-stat-pill ${timelineSubtitleCueCount > 0 ? 'is-ok' : ''}`}>{timelineSubtitleCueCount} 条字幕</span>
                      </div>
                    </div>
                    <div className="subtitle-workbench-controls">
                      <label className="edit-label">
                        编辑片段
                        <select
                          className="edit-select"
                          value={subtitleTargetClip?.clipId || ''}
                          onChange={(e) => setSubtitleTargetClipId(e.target.value || null)}
                          disabled={runningTasks.length > 0 || subtitleVideoClips.length === 0}
                        >
                          {subtitleVideoClips.map((clip) => (
                            <option key={clip.clipId} value={clip.clipId}>
                              情节 {clip.clipIndex + 1} · {clip.summary.slice(0, 22)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="btn-primary"
                        onClick={() => {
                          if (!subtitleTargetClip) {
                            setError('请先确保至少有一个生成的视频');
                            return;
                          }
                          openSubtitleEditor(subtitleTargetClip);
                        }}
                        disabled={runningTasks.length > 0 || !subtitleTargetClip}
                      >
                        打开时间轴编辑器
                      </button>
                    </div>
                    {subtitleTargetClip && (
                      <div className="subtitle-target-card">
                        <div className="subtitle-target-copy">
                          <strong>当前片段：情节 {subtitleTargetClip.clipIndex + 1}</strong>
                          <span>{subtitleTargetClip.summary}</span>
                        </div>
                        <div className="subtitle-pill-row">
                          <span className="subtitle-stat-pill">
                            {(subtitleTimelineByClip[subtitleTargetClip.clipId] || []).length} 条字幕
                          </span>
                          {subtitleTargetClip.duration ? <span className="subtitle-stat-pill">{subtitleTargetClip.duration}s</span> : null}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {subtitleMode === 'custom' && (
                  <div className="edit-option-card edit-option-card--full">
                    <label className="edit-label">
                      字幕文本
                      <textarea
                        className="edit-textarea"
                        value={subtitleText}
                        onChange={(e) => setSubtitleText(e.target.value)}
                        disabled={runningTasks.length > 0}
                        placeholder="输入要显示的字幕..."
                        rows={3}
                      />
                    </label>
                  </div>
                )}

                {subtitleMode !== 'none' && subtitleMode !== 'timeline' && (
                  <div className="edit-option-card edit-option-card--full">
                    <label className="edit-label">
                      字幕位置
                      <select
                        className="edit-select"
                        value={subtitlePosition}
                        onChange={(e) => setSubtitlePosition(e.target.value as 'top' | 'middle' | 'bottom')}
                        disabled={runningTasks.length > 0}
                      >
                        <option value="top">上方</option>
                        <option value="middle">中间</option>
                        <option value="bottom">下方</option>
                      </select>
                    </label>
                  </div>
                )}

                <div className="edit-actions">
                  <button
                    className="btn-primary btn-large"
                    onClick={handleEditVideos}
                    disabled={runningTasks.length > 0 || !hasEditReadyClips}
                  >
                    {runningTasks.length > 0 ? '处理中...' : '✂️ 开始剪辑'}
                  </button>
                </div>
              </aside>
            </div>

            {(shouldShowCompiledPreview || previewableVideoClips.length > 0) && (
              <section className="edited-video-list edited-video-list--studio editing-output-library">
                <div className="subtitle-panel-head">
                  <div>
                    <p className="subtitle-panel-kicker">Output Library</p>
                    <h3>{shouldShowCompiledPreview ? '剪辑输出结果' : '片段素材与剪辑结果'}</h3>
                    <p className="compiled-video-hint">
                      {shouldShowCompiledPreview
                        ? '这里汇总剪辑与字幕处理后的输出，完整成片固定放在底部查看。'
                        : '剪辑完成前，这里先展示各片段素材；完整成片生成后也会出现在这里。'}
                    </p>
                  </div>
                  <div className="subtitle-pill-row">
                    {shouldShowCompiledPreview ? <span className="subtitle-stat-pill is-ok">含完整成片</span> : null}
                    <span className="subtitle-stat-pill">{previewableVideoClips.length} 段片段</span>
                  </div>
                </div>

                <div className="editing-output-grid">
                  {previewableVideoClips.map((clip) => {
                    const isFinal = Boolean(clip.editedVideoUrl);
                    const url = clip.editedVideoUrl || clip.videoUrl;
                    if (!url) return null;
                    const cueCount = (subtitleTimelineByClip[clip.clipId] || []).length;
                    return (
                      <div
                        key={clip.clipId}
                        className={`edited-video-card editing-output-card ${editingPreviewClip?.clipId === clip.clipId ? 'selected' : ''}`}
                      >
                        <div className="editing-output-card-head">
                          <h4 className="video-clip-title">
                            情节 {clip.clipIndex + 1} · {clip.summary.slice(0, 40)}
                            {isFinal && <span className="final-video-badge">已剪辑</span>}
                            {clip.duration && <span className="clip-duration">⏱ {clip.duration}s</span>}
                          </h4>
                          <div className="editing-output-card-actions">
                            <button className="btn-ghost btn-small" onClick={() => setEditingPreviewTargetId(clip.clipId)}>
                              设为主预览
                            </button>
                            {subtitleMode === 'timeline' ? (
                              <button
                                className="btn-ghost btn-small"
                                onClick={() => {
                                  setSubtitleTargetClipId(clip.clipId);
                                  openSubtitleEditor(clip);
                                }}
                                disabled={runningTasks.length > 0}
                              >
                                编辑字幕
                              </button>
                            ) : null}
                          </div>
                        </div>
                        <div className="subtitle-pill-row">
                          <span className={`subtitle-stat-pill ${cueCount > 0 ? 'is-ok' : ''}`}>{cueCount} 条字幕</span>
                          {subtitleTargetClipId === clip.clipId ? <span className="subtitle-stat-pill">当前编辑目标</span> : null}
                        </div>
                        <video controls className="clip-video" playsInline preload="metadata">
                          <source src={url} />
                          {clip.subtitleUrl ? (
                            <track kind="captions" src={clip.subtitleUrl} srcLang="zh" label="中文字幕" default />
                          ) : null}
                        </video>
                      </div>
                    );
                  })}

                  {shouldShowCompiledPreview && compiledPreviewUrl ? (
                    <div className="edited-video-card editing-output-card">
                      <div className="editing-output-card-head">
                        <h4 className="video-clip-title">
                          完整成片
                          <span className="final-video-badge">最终输出</span>
                        </h4>
                      </div>
                      <p className="compiled-video-hint">全集拼接后的最终视频，适合检查整体节奏与成片观感。</p>
                      <video controls className="clip-video" playsInline preload="metadata">
                        <source src={compiledPreviewUrl} />
                        {compiledSubtitleUrl ? (
                          <track kind="captions" src={compiledSubtitleUrl} srcLang="zh" label="中文字幕" default />
                        ) : null}
                      </video>
                    </div>
                  ) : null}
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      {/* ── 字幕编辑器模态框 ── */}
      {subtitleEditorOpen && (
        <div className="modal-overlay" onClick={closeSubtitleEditor}>
          <div className="modal-content subtitle-editor-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>时间轴字幕编辑器</h2>
                <p className="subtitle-editor-subhead">
                  {subtitleEditorClipId
                    ? `情节 ${(clips.find((clip) => clip.clipId === subtitleEditorClipId)?.clipIndex ?? 0) + 1} · WebVTT 导出`
                    : '逐片段编辑字幕节奏、位置与预览动画'}
                </p>
              </div>
              <button className="modal-close" onClick={closeSubtitleEditor}>×</button>
            </div>

            <div className="subtitle-editor-body">
              <section className="subtitle-preview-stage">
                <div className="subtitle-preview-shell">
                  <div className="subtitle-preview-video-wrap">
                    {subtitleEditorUrl ? (
                      <>
                        <video
                          ref={subtitlePreviewRef}
                          src={subtitleEditorUrl}
                          controls
                          className="subtitle-preview-video"
                          playsInline
                          preload="auto"
                          onLoadedMetadata={(e) => {
                            const duration = e.currentTarget.duration || 0;
                            if (duration > 0) {
                              setSubtitleEditorDuration(duration);
                              setSubtitleEditorDurationSource('media');
                              if (subtitleEditorCurrentTime > 0) {
                                e.currentTarget.currentTime = Math.min(duration, subtitleEditorCurrentTime);
                              }
                            }
                          }}
                          onTimeUpdate={(e) => setSubtitleEditorCurrentTime(e.currentTarget.currentTime)}
                          onError={() => {
                            setSubtitleEditorDurationSource('estimated');
                            setError('视频预览受限，已切换为估算时长与关键帧预览；你仍可继续编辑字幕。');
                          }}
                        />
                        {activeSubtitleFrame && (subtitlePreviewScrubbing || subtitleEditorDurationSource === 'estimated') ? (
                          <img
                            src={activeSubtitleFrame.imageUrl}
                            alt="当前时间点预览帧"
                            className="subtitle-preview-frame-fallback"
                          />
                        ) : null}
                        <div ref={subtitlePreviewWrapRef} className="subtitle-overlay-stage">
                          {activePreviewCues.map(({ cue, index }) => (
                            <div
                              key={`${cue.start}-${index}`}
                              className={`subtitle-overlay-line is-free ${selectedCueIndex === index ? 'is-selected' : ''}`}
                              style={{
                                left: `${cue.x}%`,
                                top: `${cue.y}%`,
                              }}
                              onPointerDown={(e) => {
                                e.stopPropagation();
                                setSelectedCueIndex(index);
                                setSubtitleInspectorTab('content');
                                subtitleOverlayDragRef.current = index;
                              }}
                            >
                              <div
                                className={`subtitle-overlay-badge style-${normalizeSubtitleStylePreset(cue.stylePreset)}`}
                              >
                                <span className={`subtitle-overlay-text fx-${cue.animation}`}>{cue.text}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <div className="subtitle-preview-empty">正在准备视频预览…</div>
                    )}
                  </div>

                  <div className="subtitle-preview-stats">
                    <span className="subtitle-stat-pill">播放头 {formatTimelineTime(subtitleEditorCurrentTime)}</span>
                    <span className="subtitle-stat-pill">
                      时长 {formatTimelineTime(subtitleEditorDuration)}
                      {subtitleEditorDurationSource === 'estimated' ? ' · 估算' : ' · 视频'}
                    </span>
                    <span className={`subtitle-stat-pill ${subtitleEditorIssues === 0 ? 'is-ok' : 'is-warn'}`}>
                      {subtitleEditorIssues === 0 ? '时间轴正常' : `${subtitleEditorIssues} 个待修正项`}
                    </span>
                  </div>

                  <div
                    ref={subtitleRulerRef}
                    className="subtitle-ruler"
                    onPointerDown={(e) => {
                      if (subtitleEditorDuration <= 0) return;
                      subtitleRulerDraggingRef.current = true;
                      setSubtitlePreviewScrubbing(true);
                      subtitlePreviewRef.current?.pause();
                      seekSubtitlePreviewFromClientX(e.clientX);
                    }}
                  >
                    <div className="subtitle-ruler-track" />
                    <div className="subtitle-ruler-playhead" style={{ left: `${subtitleEditorDuration > 0 ? (subtitleEditorCurrentTime / subtitleEditorDuration) * 100 : 0}%` }} />
                    {normalizedSubtitleEditorCues.map((cue, idx) => (
                      <button
                        type="button"
                        key={`${cue.start}-${cue.end}-${idx}`}
                        className={`subtitle-ruler-segment ${selectedCueIndex === idx ? 'selected' : ''}`}
                        style={{
                          left: `${subtitleEditorDuration > 0 ? (cue.start / subtitleEditorDuration) * 100 : 0}%`,
                          width: `${subtitleEditorDuration > 0 ? ((cue.end - cue.start) / subtitleEditorDuration) * 100 : 0}%`,
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedCueIndex(idx);
                          setSubtitleInspectorTab('content');
                          seekSubtitlePreview(cue.start);
                        }}
                      >
                        <span
                          className="subtitle-ruler-handle is-start"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            setSelectedCueIndex(idx);
                            setSubtitleInspectorTab('content');
                            subtitleCueDragRef.current = { cueIndex: idx, edge: 'start' };
                            setSubtitlePreviewScrubbing(true);
                            subtitlePreviewRef.current?.pause();
                          }}
                        />
                        <span
                          className="subtitle-ruler-handle is-end"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            setSelectedCueIndex(idx);
                            setSubtitleInspectorTab('content');
                            subtitleCueDragRef.current = { cueIndex: idx, edge: 'end' };
                            setSubtitlePreviewScrubbing(true);
                            subtitlePreviewRef.current?.pause();
                          }}
                        />
                      </button>
                    ))}
                  </div>
                </div>

                {subtitleFrames.length > 0 && (
                  <div className="frames-section">
                    <div className="section-heading-row">
                      <h3>关键帧锚点</h3>
                      <span className="subtitle-section-meta">点击即在该时刻新增字幕</span>
                    </div>
                    <div className="frames-grid">
                      {subtitleFrames.map((frame, idx) => (
                        <div
                          key={idx}
                          className="frame-cell"
                          onClick={() => addSubtitleCue(frame.timestamp)}
                          title={`点击在 ${formatSrtTime(frame.timestamp)} 添加字幕`}
                        >
                          <img src={frame.imageUrl} alt={`帧 ${idx}`} className="frame-image" />
                          <span className="frame-time">{formatSrtTime(frame.timestamp)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              <section className="subtitle-editor-sidebar">
                <div className="cues-section">
                  <div className="cues-header">
                    <h3>字幕列表</h3>
                    <div className="subtitle-pill-row">
                      <button className="btn-ghost btn-small" onClick={normalizeCurrentSubtitleCues} disabled={subtitleEditorCues.length === 0}>
                        智能整理
                      </button>
                      <button className="btn-ghost btn-small" onClick={() => addSubtitleCue()} disabled={subtitleEditorDuration <= 0}>
                        ➕ 添加字幕
                      </button>
                    </div>
                  </div>

                  {subtitleEditorCues.length === 0 ? (
                    <p className="empty-hint">暂无字幕，点击关键帧或使用上方按钮直接添加</p>
                  ) : (
                    <div className="cues-list">
                      {subtitleEditorCues.map((cue, idx) => (
                        <div
                          key={idx}
                          className={`cue-card ${selectedCueIndex === idx ? 'selected' : ''}`}
                          onClick={() => {
                            const nextSelected = selectedCueIndex === idx ? null : idx;
                            setSelectedCueIndex(nextSelected);
                            if (nextSelected !== null) setSubtitleInspectorTab('content');
                          }}
                        >
                          <div className="cue-header">
                            <span className="cue-index">字幕 {idx + 1}</span>
                            <span className="cue-time">
                              {formatTimelineTime(cue.start)} → {formatTimelineTime(cue.end)}
                            </span>
                            <button
                              className="btn-small btn-ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                removeSubtitleCue(idx);
                              }}
                            >
                              🗑️
                            </button>
                          </div>

                          {selectedCueIndex === idx ? (
                            <div
                              className="cue-edit-panel"
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <div className="subtitle-inspector-tabs">
                                <button
                                  type="button"
                                  className={`subtitle-inspector-tab ${subtitleInspectorTab === 'content' ? 'selected' : ''}`}
                                  onClick={() => setSubtitleInspectorTab('content')}
                                >
                                  基础
                                </button>
                                <button
                                  type="button"
                                  className={`subtitle-inspector-tab ${subtitleInspectorTab === 'style' ? 'selected' : ''}`}
                                  onClick={() => setSubtitleInspectorTab('style')}
                                >
                                  样式
                                </button>
                                <button
                                  type="button"
                                  className={`subtitle-inspector-tab ${subtitleInspectorTab === 'motion' ? 'selected' : ''}`}
                                  onClick={() => setSubtitleInspectorTab('motion')}
                                >
                                  动画
                                </button>
                              </div>

                              {subtitleInspectorTab === 'content' && (
                                <>
                                  <div className="cue-edit-row">
                                    <label>文本</label>
                                    <textarea
                                      value={cue.text}
                                      onChange={(e) => updateSubtitleCue(idx, { text: e.target.value })}
                                      rows={2}
                                      className="cue-text-input"
                                      placeholder="输入字幕文本..."
                                    />
                                  </div>

                                  <div className="cue-edit-grid">
                                    <div className="cue-edit-row">
                                      <label>开始时间（秒）</label>
                                      <input
                                        type="number"
                                        min="0"
                                        max={subtitleEditorDuration}
                                        step="0.1"
                                        value={cue.start}
                                        onChange={(e) => updateSubtitleCue(idx, { start: parseFloat(e.target.value) })}
                                        className="cue-time-input"
                                      />
                                    </div>

                                    <div className="cue-edit-row">
                                      <label>结束时间（秒）</label>
                                      <input
                                        type="number"
                                        min="0"
                                        max={subtitleEditorDuration}
                                        step="0.1"
                                        value={cue.end}
                                        onChange={(e) => updateSubtitleCue(idx, { end: parseFloat(e.target.value) })}
                                        className="cue-time-input"
                                      />
                                    </div>
                                  </div>

                                  <div className="cue-edit-grid">
                                    <div className="cue-edit-row">
                                      <label>垂直位置</label>
                                      <select
                                        value={cue.vertical}
                                        onChange={(e) => updateSubtitleCue(idx, { vertical: e.target.value as SubtitleCue['vertical'] })}
                                        className="cue-select"
                                      >
                                        {SUBTITLE_VERTICAL_OPTIONS.map((opt) => (
                                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                                        ))}
                                      </select>
                                    </div>

                                    <div className="cue-edit-row">
                                      <label>水平对齐</label>
                                      <select
                                        value={cue.align}
                                        onChange={(e) => updateSubtitleCue(idx, { align: e.target.value as SubtitleCue['align'] })}
                                        className="cue-select"
                                      >
                                        {SUBTITLE_ALIGN_OPTIONS.map((opt) => (
                                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                                        ))}
                                      </select>
                                    </div>
                                  </div>
                                </>
                              )}

                              {subtitleInspectorTab === 'style' && (
                                <div className="cue-edit-row">
                                  <div className="subtitle-style-grid">
                                    {SUBTITLE_STYLE_OPTIONS.map((option) => (
                                      <button
                                        key={option.value}
                                        type="button"
                                        className={`subtitle-style-card ${cue.stylePreset === option.value ? 'selected' : ''}`}
                                        onClick={() => updateSubtitleCue(idx, { stylePreset: option.value })}
                                        title={option.label}
                                      >
                                        <span className={`subtitle-style-swatch style-${option.value}`}>
                                          {option.preview}
                                        </span>
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {subtitleInspectorTab === 'motion' && (
                                <div className="cue-edit-row">
                                  <label>动画效果</label>
                                  <div className="subtitle-animation-grid">
                                    {SUBTITLE_ANIMATION_OPTIONS.map((opt) => (
                                      <button
                                        key={opt.value}
                                        type="button"
                                        className={`subtitle-animation-chip ${cue.animation === opt.value ? 'selected' : ''}`}
                                        onClick={() => updateSubtitleCue(idx, { animation: opt.value })}
                                      >
                                        {opt.label}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="cue-preview">
                              <p className="cue-text-preview">{cue.text || '未填写字幕文本'}</p>
                              <span className="cue-position-badge">
                                {SUBTITLE_STYLE_MAP[normalizeSubtitleStylePreset(cue.stylePreset)]?.label} · {SUBTITLE_VERTICAL_OPTIONS.find((o) => o.value === cue.vertical)?.label} · {SUBTITLE_ALIGN_OPTIONS.find((o) => o.value === cue.align)?.label} · {SUBTITLE_ANIMATION_OPTIONS.find((o) => o.value === cue.animation)?.label}
                              </span>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            </div>

            <div className="modal-footer">
              <button className="btn-ghost" onClick={closeSubtitleEditor}>取消</button>
              <button
                className="btn-primary"
                onClick={() => {
                  setSubtitleMode('timeline');
                  closeSubtitleEditor();
                }}
                disabled={subtitleEditorCues.length === 0}
              >
                ✓ 确认编辑
              </button>
            </div>
          </div>
        </div>
      )}

      <EpisodeEvaluationModal
        open={evaluationModal.open}
        onClose={closeEvaluationModal}
        evaluation={activeEpisode?.evaluation}
        episode={activeEpisode}
        scope={evaluationModal.scope}
        onReevaluate={reevaluateForModalScope}
        disabled={runningTasks.length > 0}
      />
    </div>
  );
}
