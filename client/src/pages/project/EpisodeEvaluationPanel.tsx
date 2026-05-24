import { useEffect } from 'react';
import type { Episode, EpisodeEvaluation, EvaluationScopeResult, EvaluationIssue } from '../../types/project';

type Scope = 'story_analysis' | 'beat_frames' | 'all';

type Props = {
  evaluation?: EpisodeEvaluation | null;
  episode?: Episode | null;
  scope?: Scope;
  onReevaluate?: () => void;
  disabled?: boolean;
};

type ModalProps = Props & {
  open: boolean;
  onClose: () => void;
};

type BadgeProps = {
  evaluation?: EpisodeEvaluation | null;
  scope?: Scope;
  onOpen: () => void;
};

const CRITERION_LABELS: Record<string, string> = {
  coverage: '剧情覆盖',
  segmentation: '切分合理性',
  character_consistency: '角色一致性',
  location_consistency: '场景一致性',
  clip_metadata: '情节元数据',
  narrative_continuity: '叙事连贯',
  visual_readiness: '视觉可用性',
  completeness: '完整性',
  story_alignment: '剧情对齐',
  scene_prompt_quality: 'Prompt 质量',
  visual_only_compliance: '纯视觉合规',
  inter_clip_continuity: '跨段连贯',
  motion_readiness: '视频运动可用',
  reference_friendliness: '参考图友好',
};

const SEVERITY_LABELS: Record<EvaluationIssue['severity'], string> = {
  critical: '严重',
  major: '主要',
  minor: '轻微',
  info: '提示',
};

const SCOPE_LABELS: Record<EvaluationScopeResult['scope'], string> = {
  story_analysis: '故事分析',
  beat_frames: '首尾帧 Prompt',
};

function scoreClass(score: number): string {
  if (score >= 85) return 'good';
  if (score >= 65) return 'warn';
  return 'bad';
}

function isStale(evaluation: EpisodeEvaluation, episode?: Episode | null): boolean {
  if (!episode?.updatedAt || !evaluation.createdAt) return false;
  return new Date(evaluation.createdAt).getTime() < new Date(episode.updatedAt).getTime();
}

export function scopeResults(evaluation: EpisodeEvaluation, scope: Scope): EvaluationScopeResult[] {
  const out: EvaluationScopeResult[] = [];
  if ((scope === 'all' || scope === 'story_analysis') && evaluation.storyAnalysis) {
    out.push(evaluation.storyAnalysis);
  }
  if ((scope === 'all' || scope === 'beat_frames') && evaluation.beatFrames) {
    out.push(evaluation.beatFrames);
  }
  return out;
}

export function hasEvaluationForScope(
  evaluation: EpisodeEvaluation | null | undefined,
  scope: Scope,
): boolean {
  if (!evaluation) return false;
  return scopeResults(evaluation, scope).length > 0;
}

function renderIssues(issues: EvaluationIssue[]) {
  if (issues.length === 0) return <p className="evaluation-empty">未发现明确问题。</p>;
  const sorted = [...issues].sort((a, b) => {
    const order = { critical: 0, major: 1, minor: 2, info: 3 };
    return order[a.severity] - order[b.severity];
  });
  return (
    <div className="evaluation-issues">
      {sorted.map((issue, idx) => (
        <div key={`${issue.targetType}-${issue.targetId}-${idx}`} className={`evaluation-issue ${issue.severity}`}>
          <div className="evaluation-issue-head">
            <span className={`severity-pill ${issue.severity}`}>{SEVERITY_LABELS[issue.severity]}</span>
            <strong>{issue.title || '未命名问题'}</strong>
            <span className="issue-target">
              {issue.targetType}{issue.targetId ? ` · ${issue.targetId}` : ''}{issue.frame ? ` · ${issue.frame}` : ''}
            </span>
          </div>
          {issue.detail && <p>{issue.detail}</p>}
          {issue.suggestion && <p className="issue-suggestion">建议：{issue.suggestion}</p>}
        </div>
      ))}
    </div>
  );
}

function ScopeSection({ result }: { result: EvaluationScopeResult }) {
  return (
    <section className="evaluation-scope">
      <div className="evaluation-scope-head">
        <h4>{SCOPE_LABELS[result.scope]}</h4>
        <span className={`score-pill ${scoreClass(result.score)}`}>{result.score} · {result.grade}</span>
      </div>
      <p className="evaluation-summary">{result.summary || '暂无总体评价。'}</p>
      <div className="evaluation-criteria-grid">
        {Object.entries(result.criteria || {}).map(([key, row]) => (
          <div key={key} className="evaluation-criterion">
            <div className="criterion-top">
              <span>{CRITERION_LABELS[key] || key}</span>
              <strong className={scoreClass(row.score)}>{row.score}</strong>
            </div>
            <p>{row.comment}</p>
          </div>
        ))}
      </div>
      {result.strengths.length > 0 && (
        <div className="evaluation-strengths">
          <strong>优点</strong>
          <ul>
            {result.strengths.map((s, i) => <li key={`${s}-${i}`}>{s}</li>)}
          </ul>
        </div>
      )}
      <h5>问题与建议</h5>
      {renderIssues(result.issues || [])}
    </section>
  );
}

function EvaluationPanelContent({
  evaluation,
  episode,
  scope = 'all',
  onReevaluate,
  disabled,
}: Props) {
  const results = scopeResults(evaluation!, scope);

  return (
    <div className="evaluation-panel evaluation-panel--modal-body">
      <div className="evaluation-panel-head">
        <div>
          <p>{evaluation!.overall.summary || '评估完成。'}</p>
        </div>
        <div className="evaluation-overall">
          <span className={`overall-score ${scoreClass(evaluation!.overall.score)}`}>
            {evaluation!.overall.score}
          </span>
          <span>{evaluation!.overall.grade} · {evaluation!.overall.verdict}</span>
        </div>
      </div>

      {isStale(evaluation!, episode) && (
        <div className="evaluation-stale">评估可能已过期：剧集内容在评估后发生过更新。</div>
      )}

      <div className="evaluation-meta">
        <span>评估时间：{new Date(evaluation!.createdAt).toLocaleString()}</span>
        <span>严重问题：{evaluation!.overall.criticalIssueCount}</span>
        <span>主要问题：{evaluation!.overall.majorIssueCount}</span>
        {onReevaluate && (
          <button type="button" className="btn-ghost btn-small" onClick={onReevaluate} disabled={disabled}>
            重新评估
          </button>
        )}
      </div>

      {results.map((result) => <ScopeSection key={result.scope} result={result} />)}
    </div>
  );
}

/** 阶段栏上的紧凑入口：显示总分，点击打开弹窗 */
export function EvaluationScoreBadge({ evaluation, scope = 'all', onOpen }: BadgeProps) {
  if (!evaluation || !hasEvaluationForScope(evaluation, scope)) return null;

  const { score, grade, criticalIssueCount, majorIssueCount } = evaluation.overall;
  const issueHint =
    criticalIssueCount + majorIssueCount > 0
      ? ` · ${criticalIssueCount + majorIssueCount} 项待关注`
      : '';

  return (
    <button
      type="button"
      className={`evaluation-score-badge ${scoreClass(score)}`}
      onClick={onOpen}
      title="查看质量评估详情"
    >
      <span className="evaluation-score-badge-label">质量评估</span>
      <span className={`evaluation-score-badge-score ${scoreClass(score)}`}>{score}</span>
      <span className="evaluation-score-badge-meta">{grade}{issueHint}</span>
    </button>
  );
}

/** 质量评估弹窗 */
export function EpisodeEvaluationModal({
  open,
  onClose,
  evaluation,
  episode,
  scope = 'all',
  onReevaluate,
  disabled,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open || !evaluation || !hasEvaluationForScope(evaluation, scope)) return null;

  return (
    <div
      className="modal-overlay evaluation-modal-overlay"
      role="presentation"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="modal evaluation-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="evaluation-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="evaluation-modal-toolbar">
          <h2 id="evaluation-modal-title" className="modal-title evaluation-modal-title">质量评估</h2>
          <button type="button" className="btn-ghost evaluation-modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <EvaluationPanelContent
          evaluation={evaluation}
          episode={episode}
          scope={scope}
          onReevaluate={onReevaluate}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

/** @deprecated 内联面板已改为弹窗，保留导出以免破坏引用 */
export function EpisodeEvaluationPanel(props: Props) {
  if (!props.evaluation || !hasEvaluationForScope(props.evaluation, props.scope ?? 'all')) return null;
  return <EvaluationPanelContent {...props} />;
}
