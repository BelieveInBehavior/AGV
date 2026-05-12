import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  getProject,
  listEpisodes,
  createEpisode,
  listClips,
  generateStory,
  generateStoryboard,
  generateImages,
  getTask,
  listTasks,
  connectSSE,
} from '../../services/project';
import type { Project, Episode, Clip, Task, SseEvent } from '../../types/project';

type Stage = 'input' | 'clips' | 'storyboard' | 'images';

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
  const [error, setError] = useState('');

  const sseCleanup = useRef<(() => void) | null>(null);
  const activeEpisodeRef = useRef<Episode | null>(null);
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
        setTasks((prev) => ({
          ...prev,
          [event.taskId]: { ...(prev[event.taskId] as Task), status: 'completed', progress: 100 },
        }));
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
    [projectId, refreshProjectData]
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
  }, [nonTerminalTaskKey, projectId, refreshProjectData]);

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
            setStage(ep.status === 'storyboard_ready' ? 'storyboard' : 'clips');
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

  // 生成分镜
  const handleGenerateStoryboard = async () => {
    if (!projectId || !activeEpisode) return;
    setError('');
    try {
      const taskId = await generateStoryboard(projectId, activeEpisode.episodeId);
      addTask(taskId, 'STORYBOARD_GEN', activeEpisode.episodeId);
      setStage('storyboard');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '生成失败');
    }
  };

  // 生成图片
  const handleGenerateImages = async (panelIds?: string[]) => {
    if (!projectId || !activeEpisode) return;
    setError('');
    try {
      const taskId = await generateImages(projectId, activeEpisode.episodeId, panelIds);
      addTask(taskId, 'IMAGE_GENERATION', activeEpisode.episodeId);
      setStage('images');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '生成失败');
    }
  };

  const runningTasks = Object.values(tasks).filter((t) => isRunningTaskStatus(t.status));

  if (loading) return <div className="loading-full">加载中...</div>;
  if (!project) return <div className="loading-full">项目不存在</div>;

  const allPanels = clips.flatMap((c) => c.panels || []);

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

      {/* 进度步骤条 */}
      <div className="stage-bar">
        {(['input', 'clips', 'storyboard', 'images'] as Stage[]).map((s, i) => (
          <div key={s} className={`stage-step ${stage === s ? 'active' : ''} ${['input','clips','storyboard','images'].indexOf(stage) > i ? 'done' : ''}`}>
            <span className="step-num">{i + 1}</span>
            <span className="step-label">{{ input: '输入文本', clips: '情节分析', storyboard: '生成分镜', images: '生成图片' }[s]}</span>
          </div>
        ))}
      </div>

      {/* 运行中任务进度 */}
      {runningTasks.map((t) => (
        <div key={t.taskId} className="task-progress-bar">
          <div className="task-info">
            <span className="task-type">{{ STORY_ANALYSIS: '故事分析', STORYBOARD_GEN: '分镜生成', IMAGE_GENERATION: '图片生成' }[t.type]}</span>
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
                <button className="btn-ghost" onClick={() => setStage('input')}>← 重新输入</button>
                {clips.length > 0 && (
                  <button
                    className="btn-primary"
                    onClick={handleGenerateStoryboard}
                    disabled={runningTasks.length > 0}
                  >
                    {runningTasks.length > 0 ? '生成中...' : '🎬 生成分镜'}
                  </button>
                )}
              </div>
            </div>

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
                  {clips.map((clip) => (
                    <div key={clip.clipId} className="clip-card">
                      <div className="clip-header">
                        <span className="clip-num">情节 {clip.clipIndex + 1}</span>
                        <span className="clip-location">📍 {clip.location}</span>
                        <span className={`clip-mood mood-${clip.mood}`}>{clip.mood}</span>
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

        {/* ── 阶段3: 分镜面板 ── */}
        {stage === 'storyboard' && (
          <div className="stage-panel">
            <div className="stage-header">
              <h2>分镜预览</h2>
              <div className="header-actions">
                <button className="btn-ghost" onClick={() => setStage('clips')}>← 返回情节</button>
                {allPanels.length > 0 && (
                  <button
                    className="btn-primary"
                    onClick={() => handleGenerateImages()}
                    disabled={runningTasks.length > 0}
                  >
                    {runningTasks.length > 0 ? '生成中...' : '🖼️ 生成全部图片'}
                  </button>
                )}
              </div>
            </div>

            {runningTasks.length > 0 && allPanels.length === 0 ? (
              <div className="analyzing-state">
                <div className="spinner" />
                <p>AI 正在规划分镜...</p>
              </div>
            ) : allPanels.length === 0 ? (
              <p className="empty-hint">暂无分镜，请等待生成或重新生成</p>
            ) : (
              <div className="storyboard-grid">
                {clips.map((clip) => (
                  <div key={clip.clipId} className="clip-section">
                    <h3 className="clip-section-title">
                      情节 {clip.clipIndex + 1}: {clip.summary}
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
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── 阶段4: 图片画廊 ── */}
        {stage === 'images' && (
          <div className="stage-panel">
            <div className="stage-header">
              <h2>图片画廊</h2>
              <div className="header-actions">
                <button className="btn-ghost" onClick={() => setStage('storyboard')}>← 返回分镜</button>
                <button
                  className="btn-primary"
                  onClick={() => handleGenerateImages()}
                  disabled={runningTasks.length > 0}
                >
                  {runningTasks.length > 0 ? '生成中...' : '🔄 重新生成全部'}
                </button>
              </div>
            </div>

            <div className="image-gallery">
              {allPanels.map((panel) => (
                <div key={panel.panelId} className={`gallery-item ${panel.imageUrl ? 'has-image' : ''}`}>
                  {panel.imageUrl ? (
                    <img src={panel.imageUrl} alt={panel.description} className="gallery-img" />
                  ) : (
                    <div className="gallery-placeholder">
                      {runningTasks.length > 0 ? (
                        <div className="spinner-sm" />
                      ) : (
                        <span>待生成</span>
                      )}
                    </div>
                  )}
                  <div className="gallery-caption">{panel.description.slice(0, 60)}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
