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
  isLegacyBeatPlan,
  resolveBeatFrames,
  storyboardPlanForDisplay,
} from './beatPlanHelpers';
import { sceneRefReady } from './visualRefHelpers';

type Stage = 'input' | 'clips' | 'prompts' | 'images' | 'video';
type EvaluationScope = 'story_analysis' | 'beat_frames' | 'all';

function scopesToModalScope(scopes: ('story_analysis' | 'beat_frames')[]): EvaluationScope {
  return scopes.length >= 2 ? 'all' : scopes[0];
}

const STAGE_ORDER: Stage[] = ['input', 'clips', 'prompts', 'images', 'video'];

function defaultStageForEpisode(ep: Episode | null): Stage {
  if (!ep) return 'input';
  switch (ep.status) {
    case 'video_ready':
    case 'complete':
      return 'video';
    case 'images_ready':
      return 'images';
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

function buildGalleryItems(clips: Clip[]): {
  key: string;
  imageUrl: string | null;
  caption: string;
  panelId?: string;
}[] {
  const items: { key: string; imageUrl: string | null; caption: string; panelId?: string }[] = [];
  for (const clip of clips) {
    for (const p of clip.panels || []) {
      items.push({
        key: p.panelId,
        panelId: p.panelId,
        imageUrl: p.imageUrl,
        caption: p.description,
      });
    }
    const p = clip.storyboardPlan;
    if (!p) continue;
    const { first_frame: ff, last_frame: lf } = resolveBeatFrames(p);
    if (ff) {
      items.push({
        key: `${clip.clipId}-v2-first`,
        imageUrl: ff.imageUrl ?? null,
        caption: `情节 ${clip.clipIndex + 1} · 首帧 — ${ff.description ?? ''}`,
      });
      items.push({
        key: `${clip.clipId}-v2-last`,
        imageUrl: lf?.imageUrl ?? null,
        caption: `情节 ${clip.clipIndex + 1} · 末帧 — ${lf?.description ?? ''}`,
      });
    }
  }
  return items;
}

/** 首尾帧链路：选中方案首末帧是否都已出图 */
function beatImagesComplete(clips: Clip[]): boolean {
  const withPlan = clips.filter((c) => hasBeatStoryboardContent(c.storyboardPlan ?? undefined));
  if (withPlan.length === 0) return false;
  return withPlan.every((clip) => {
    const { first_frame: ff, last_frame: lf } = resolveBeatFrames(clip.storyboardPlan);
    return Boolean(ff?.imageUrl && lf?.imageUrl);
  });
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
  if (target === 'images') {
    return ['images_ready', 'video_ready', 'complete'].includes(st) || hasPlan;
  }
  if (target === 'video') {
    return (
      ['video_ready', 'complete'].includes(st) ||
      beatImagesComplete(clips) ||
      clips.some((c) => Boolean(c.videoUrl))
    );
  }
  return false;
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

  // 主流程：首尾帧 Prompt
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
      setStage('images');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '生成失败');
    }
  };

  const handleGenerateVideos = async () => {
    if (!projectId || !activeEpisode) return;
    setError('');
    try {
      const taskId = await generateVideos(projectId, activeEpisode.episodeId);
      addTask(taskId, 'VIDEO_GENERATION', activeEpisode.episodeId);
      setStage('video');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '生成失败');
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
  const hasLegacyBeatPlan = clips.some((c) => isLegacyBeatPlan(c.storyboardPlan ?? undefined));
  const galleryItems = buildGalleryItems(clips);
  const hasStoryboardVisualPlan = allPanels.length > 0 || hasBeatStoryboard;
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
                    prompts: '首尾帧 Prompt',
                    images: '首尾帧图片',
                    video: '生成视频',
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
                  BEAT_PROMPT_GEN: '首尾帧 Prompt',
                  STORYBOARD_GEN: '经典分镜',
                  IMAGE_GENERATION: '图片生成',
                  VIDEO_GENERATION: '视频生成',
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
                    {runningTasks.length > 0 ? '生成中...' : '📝 生成首尾帧 Prompt'}
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
                    查看首尾帧 Prompt →
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

        {/* ── 阶段3: 首尾帧 Prompt（LLM 文案，尚未生图）── */}
        {stage === 'prompts' && (
          <div className="stage-panel">
            <div className="stage-header">
              <h2>首尾帧 Prompt</h2>
              <div className="header-actions">
                <button className="btn-ghost" onClick={() => goToStage('clips')}>← 返回情节</button>
                {hasStoryboardVisualPlan && (
                  <button
                    className="btn-primary"
                    onClick={() => handleGenerateImages()}
                    disabled={runningTasks.length > 0}
                  >
                    {runningTasks.length > 0 ? '生成中...' : '🖼️ 生成首尾帧图片'}
                  </button>
                )}
                {hasBeatStoryboard && (
                  <button
                    className="btn-ghost"
                    onClick={() => handleEvaluate(['beat_frames'])}
                    disabled={runningTasks.length > 0}
                  >
                    🔍 评估首尾帧
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
              视觉资产库中，<strong>角色形象参考图必须为竖屏 {CHARACTER_REFERENCE_RATIO}</strong>（AI 生成与本地上传均遵守）；场景参考图比例跟随项目视频设置。
            </p>

            {runningTasks.length > 0 && !hasStoryboardVisualPlan ? (
              <div className="analyzing-state">
                <div className="spinner" />
                <p>AI 正在生成首尾帧英文生图 Prompt 与运动描述…</p>
              </div>
            ) : !hasStoryboardVisualPlan ? (
              <p className="empty-hint">请先在情节页点击「生成首尾帧 Prompt」或使用高级经典分镜</p>
            ) : (
              <div className="storyboard-grid prompts-stage-layout">
                {hasLegacyBeatPlan ? (
                  <p className="beat-ref-stale">
                    检测到旧版分镜数据（多方案 candidates）。页面已按选中方案展示 Prompt；生成图片前建议在情节页重新点击「生成首尾帧
                    Prompt」以写入 v2 扁平结构。
                  </p>
                ) : null}
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
                          <span className="beat-badge">首尾帧</span>
                          {clip.duration && (
                            <span className="clip-duration">⏱ {clip.duration}s</span>
                          )}
                        </h3>
                        <p className="beat-dramatic">
                          <strong>节拍：</strong>
                          {plan.dramatic_beat}
                        </p>
                        <p className="beat-motion">
                          <strong>运动与镜头：</strong>
                          {plan.motion_prompt}
                        </p>
                        <p className="beat-continuity">
                          <strong>连贯：</strong>
                          {plan.continuity_notes}
                        </p>
                        <BeatKeyframeEditor
                          clip={clip}
                          project={project}
                          projectId={projectId!}
                          episodeId={activeEpisode.episodeId}
                          plan={storyboardPlanForDisplay(plan)}
                          disabled={runningTasks.length > 0}
                          onClipUpdated={mergeClipIntoState}
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

        {/* ── 阶段4: 首尾帧图片画廊 ── */}
        {stage === 'images' && (
          <div className="stage-panel">
            <div className="stage-header">
              <h2>首尾帧图片</h2>
              <div className="header-actions">
                <button className="btn-ghost" onClick={() => goToStage('prompts')}>← 返回 Prompt</button>
                <button
                  className="btn-primary"
                  onClick={() => handleGenerateImages()}
                  disabled={runningTasks.length > 0}
                >
                  {runningTasks.length > 0 ? '生成中...' : '🔄 重新生成全部图片'}
                </button>
                {hasBeatStoryboard && beatImagesComplete(clips) && (
                  <button
                    className="btn-primary"
                    onClick={handleGenerateVideos}
                    disabled={runningTasks.length > 0}
                  >
                    {runningTasks.length > 0 ? '…' : '🎬 生成视频'}
                  </button>
                )}
              </div>
            </div>

            <div className="image-gallery">
              {galleryItems.map((item) => (
                <div key={item.key} className={`gallery-item ${item.imageUrl ? 'has-image' : ''}`}>
                  {item.imageUrl ? (
                    <img src={item.imageUrl} alt={item.caption} className="gallery-img" />
                  ) : (
                    <div className="gallery-placeholder">
                      {runningTasks.length > 0 ? (
                        <div className="spinner-sm" />
                      ) : (
                        <span>待生成</span>
                      )}
                    </div>
                  )}
                  <div className="gallery-caption">{item.caption.slice(0, 80)}</div>
                  {!item.imageUrl && item.panelId && (
                    <button
                      type="button"
                      className="btn-gen-img gallery-one-btn"
                      onClick={() => handleGenerateImages([item.panelId!])}
                      disabled={runningTasks.length > 0}
                    >
                      生成
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── 阶段5: 视频 ── */}
        {stage === 'video' && (
          <div className="stage-panel">
            <div className="stage-header">
              <h2>视频预览</h2>
              <div className="header-actions">
                <button className="btn-ghost" onClick={() => goToStage('images')}>← 返回图片</button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleGenerateVideos}
                  disabled={runningTasks.length > 0 || !beatImagesComplete(clips)}
                >
                  {runningTasks.length > 0 ? '生成中...' : '🔄 重新生成视频'}
                </button>
              </div>
            </div>
            <p className="stage-hint">
              使用当前方案的首尾帧图与节拍/运动描述请求视频接口（`VIDEO_API_BASE_URL` 等，或账号 AI
              设置）。未配置成功时会写入短占位视频以便联调。
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
                暂无视频。请先到「首尾帧图片」页完成出图，再点击「生成视频」。
              </p>
            ) : null}
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
