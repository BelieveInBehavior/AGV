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

type Stage = 'input' | 'clips' | 'prompts' | 'video' | 'editing';
type EvaluationScope = 'story_analysis' | 'beat_frames' | 'all';

function scopesToModalScope(scopes: ('story_analysis' | 'beat_frames')[]): EvaluationScope {
  return scopes.length >= 2 ? 'all' : scopes[0];
}

const STAGE_ORDER: Stage[] = ['input', 'clips', 'prompts', 'video', 'editing'];

function defaultStageForEpisode(ep: Episode | null): Stage {
  if (!ep) return 'input';
  switch (ep.status) {
    case 'edited':
    case 'editing':
      return 'editing';
    case 'video_ready':
    case 'complete':
      return 'video';
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
        'complete',
      ].includes(st)
    );
  }
  if (target === 'video') {
    return (
      ['video_ready', 'edited', 'complete'].includes(st) ||
      hasPlan ||
      clips.some((c) => Boolean(c.videoUrl))
    );
  }
  if (target === 'editing') {
    return (
      ['editing', 'edited', 'complete'].includes(st) ||
      clips.some((c) => Boolean(c.editedVideoUrl))
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
  const [evaluationModal, setEvaluationModal] = useState<{ open: boolean; scope: EvaluationScope }>({
    open: false,
    scope: 'all',
  });

  const sseCleanup = useRef<(() => void) | null>(null);
  const activeEpisodeRef = useRef<Episode | null>(null);
  const pendingEvaluationScopeRef = useRef<EvaluationScope | null>(null);
  const handledEvaluationTasksRef = useRef(new Set<string>());
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
      setStage('video');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '生成失败');
    }
  };

  const handleEditVideos = async () => {
    if (!projectId || !activeEpisode) return;
    setError('');
    const clipIds = readyBeatVideoClipIds.length > 0 ? readyBeatVideoClipIds : undefined;
    try {
      const taskId = await editVideos(projectId, activeEpisode.episodeId, {
        clipIds,
        editOptions: {
          strategy: editStrategy,
          removeVocals: removeVocals ? 'soft' : false,
          transitionDuration: editTransition,
        },
      });
      addTask(taskId, 'VIDEO_EDITING', activeEpisode.episodeId);
      setStage('editing');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '剪辑失败');
    }
  };

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

  const runningTasks = Object.values(tasks).filter((t) => isRunningTaskStatus(t.status));

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
          {runningTasks.length > 0 && (
            <span className="task-indicator">⏳ {runningTasks.length} 个任务运行中</span>
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
                    video: '视频预览',
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
                  VIDEO_EDITING: '视频剪辑',
                  EPISODE_EVALUATION: '质量评估',
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
              </div>
            </div>
            <p className="stage-hint">
              视觉资产库中，<strong>角色形象参考图必须为竖屏 {CHARACTER_REFERENCE_RATIO}</strong>（AI 生成与本地上传均遵守）；场景参考图比例跟随项目视频设置。当前流程会保留首帧 Prompt 和首帧图片生成，并直接使用首帧图、视频 Prompt 与参考图生成视频，不再单独走尾帧 Prompt。
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

        {/* ── 阶段4: 视频 ── */}
        {stage === 'video' && (
          <div className="stage-panel">
            <div className="stage-header">
              <h2>视频预览</h2>
              <div className="header-actions">
                <button className="btn-ghost" onClick={() => goToStage('prompts')}>← 返回 Prompt</button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => handleGenerateVideos(readyBeatVideoClipIds)}
                  disabled={runningTasks.length > 0 || !hasReadyBeatVideoClips}
                >
                  {runningTasks.length > 0 ? '生成中...' : '🔄 重新生成视频'}
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => handleEditVideos()}
                  disabled={runningTasks.length > 0 || !hasEditReadyClips}
                >
                  {runningTasks.length > 0 ? '剪辑中...' : '✂️ 视频剪辑'}
                </button>
              </div>
            </div>
            <p className="stage-hint">
              使用当前方案的首帧图（由首帧 Prompt 生成）、视频 Prompt 与项目/情节参考图向 Ark 提交视频任务；顶部按钮会按当前已就绪情节提交生成。
            </p>
            <div className="video-clip-list">
              {clips.map((clip) =>
                clip.videoUrl ? (
                  <div key={clip.clipId} className="video-clip-card">
                    <h4 className="video-clip-title">
                      情节 {clip.clipIndex + 1} · {clip.summary.slice(0, 40)}
                      {clip.duration && <span className="clip-duration">⏱ {clip.duration}s</span>}
                    </h4>
                    <video src={clip.videoUrl} controls className="clip-video" playsInline />
                  </div>
                ) : null,
              )}
            </div>
            {!clips.some((c) => c.videoUrl) && runningTasks.length === 0 ? (
              <p className="empty-hint">
                {hasReadyBeatVideoClips
                  ? '暂无视频。当前已有可生成情节，点击「生成视频」即可。'
                  : '暂无视频。请先生成首帧图片，再点击「生成视频」。'}
              </p>
            ) : null}
          </div>
        )}

        {/* ── 阶段5: 视频剪辑 ── */}
        {stage === 'editing' && (
          <div className="stage-panel">
            <div className="stage-header">
              <h2>视频剪辑与后处理</h2>
              <div className="header-actions">
                <button className="btn-ghost" onClick={() => goToStage('video')}>← 返回预览</button>
              </div>
            </div>
            <p className="stage-hint">
              对已生成的视频进行后处理：支持单独编辑各情节或全集拼接。可选功能包括去人声、过渡特效等。
            </p>
            <div className="edit-options-panel">
              <div className="edit-option-row">
                <label className="edit-label">
                  剪辑策略
                  <select
                    className="edit-select"
                    value={editStrategy}
                    onChange={(e) => setEditStrategy(e.target.value as 'individual' | 'compile')}
                    disabled={runningTasks.length > 0}
                  >
                    <option value="individual">单独编辑各情节</option>
                    <option value="compile">全集拼接（推荐）</option>
                  </select>
                </label>
              </div>
              <div className="edit-option-row">
                <label className="edit-label">
                  <input
                    type="checkbox"
                    checked={removeVocals}
                    onChange={(e) => setRemoveVocals(e.target.checked)}
                    disabled={runningTasks.length > 0}
                  />
                  {' '}去人声处理（保留背景音乐）
                </label>
              </div>
              {editStrategy === 'compile' && (
                <div className="edit-option-row">
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
            </div>

            <div className="edited-video-list">
              <h3>已剪辑视频</h3>
              {clips.some((c) => c.editedVideoUrl) ? (
                clips.map((clip) =>
                  clip.editedVideoUrl ? (
                    <div key={clip.clipId} className="edited-video-card">
                      <h4 className="video-clip-title">
                        情节 {clip.clipIndex + 1} · {clip.summary.slice(0, 40)}
                        {clip.duration && <span className="clip-duration">⏱ {clip.duration}s</span>}
                      </h4>
                      <video src={clip.editedVideoUrl} controls className="clip-video" playsInline />
                    </div>
                  ) : null,
                )
              ) : (
                <p className="empty-hint">
                  {hasEditReadyClips
                    ? '暂无已剪辑视频。点击「开始剪辑」即可处理。'
                    : '暂无可编辑视频。请先生成视频。'}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

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
