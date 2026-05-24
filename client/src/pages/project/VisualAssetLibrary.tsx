import { useRef, useState } from 'react';
import {
  CHARACTER_REFERENCE_RATIO,
  isCharacterReferenceAspectRatio,
  readImageFileDimensions,
} from '../../config/visual-assets';
import type { Clip, Project } from '../../types/project';
import { patchProjectReferences, generateProjectReferenceImage } from '../../services/project';

type Props = {
  project: Project;
  projectId: string;
  episodeId: string | undefined;
  clips: Clip[];
  disabled: boolean;
  onProjectUpdated: (p: Project) => void;
  onError: (msg: string) => void;
};

function PromptEditor({
  kind,
  name,
  value,
  projectId,
  episodeId,
  disabled,
  onProjectUpdated,
  onError,
}: {
  kind: 'character' | 'location';
  name: string;
  value: string;
  projectId: string;
  episodeId: string | undefined;
  disabled: boolean;
  onProjectUpdated: (p: Project) => void;
  onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const dirty = draft !== value;

  const save = async () => {
    setSaving(true);
    try {
      const p = await patchProjectReferences(projectId, {
        episodeId,
        ...(kind === 'character'
          ? { characters: [{ name, imagePrompt: draft }] }
          : { locations: [{ name, imagePrompt: draft }] }),
      });
      onProjectUpdated(p);
    } catch (e) {
      onError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="visual-asset-prompt-section">
      <div className="visual-asset-prompt-label" onClick={() => setOpen(!open)}>
        <span className={`visual-asset-prompt-toggle ${open ? 'open' : ''}`}>▶</span>
        Image Prompt {value ? '' : '(未生成)'}
      </div>
      {open && (
        <>
          <textarea
            className="visual-asset-prompt-text"
            value={draft}
            placeholder="分析故事后自动生成，也可手动编辑"
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
          />
          {dirty && (
            <button
              type="button"
              className="visual-asset-prompt-save"
              disabled={disabled || saving}
              onClick={() => void save()}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

export function VisualAssetLibrary({
  project,
  projectId,
  episodeId,
  clips,
  disabled,
  onProjectUpdated,
  onError,
}: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<Record<string, HTMLInputElement | null>>({});

  const handleAi = async (kind: 'character' | 'location', name: string) => {
    const key = `ai:${kind}:${name}`;
    setBusy(key);
    try {
      const { project: p } = await generateProjectReferenceImage(projectId, {
        kind,
        name,
        episodeId,
      });
      onProjectUpdated(p);
    } catch (e) {
      onError(e instanceof Error ? e.message : '生成失败');
    } finally {
      setBusy(null);
    }
  };

  const handleFile = async (kind: 'character' | 'location', name: string, file: File | null) => {
    if (!file) return;
    setBusy(`up:${kind}:${name}`);
    try {
      if (kind === 'character') {
        const { width, height } = await readImageFileDimensions(file);
        if (!isCharacterReferenceAspectRatio(width, height)) {
          throw new Error(
            `角色形象图必须为 ${CHARACTER_REFERENCE_RATIO}（当前约 ${width}×${height}）`,
          );
        }
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => reject(new Error('读取文件失败'));
        r.readAsDataURL(file);
      });
      if (!dataUrl.startsWith('data:image/')) {
        throw new Error('请选择图片文件');
      }
      const p = await patchProjectReferences(projectId, {
        episodeId,
        ...(kind === 'character'
          ? { characters: [{ name, referenceImageUrl: dataUrl }] }
          : { locations: [{ name, referenceImageUrl: dataUrl }] }),
      });
      onProjectUpdated(p);
    } catch (e) {
      onError(e instanceof Error ? e.message : '上传失败');
    } finally {
      setBusy(null);
    }
  };

  const clearRef = async (kind: 'character' | 'location', name: string) => {
    setBusy(`clr:${kind}:${name}`);
    try {
      const p = await patchProjectReferences(projectId, {
        episodeId,
        ...(kind === 'character'
          ? { characters: [{ name, referenceImageUrl: null }] }
          : { locations: [{ name, referenceImageUrl: null }] }),
      });
      onProjectUpdated(p);
    } catch (e) {
      onError(e instanceof Error ? e.message : '清除失败');
    } finally {
      setBusy(null);
    }
  };

  const usedByClipCount = (kind: 'character' | 'location', name: string) => {
    const n = name.trim();
    if (!clips.length) return 0;
    if (kind === 'location') {
      return clips.filter((c) => c.location.trim() === n).length;
    }
    return clips.filter((c) => c.characters.some((x) => x.trim() === n)).length;
  };

  return (
    <section className="visual-asset-library">
      <div className="visual-asset-library-head">
        <h3 className="visual-asset-title">视觉资产库</h3>
        <p className="visual-asset-hint">
          为角色与场景准备参考图后再生成首尾帧，可降低人物与场景漂移。支持本地上传或 AI 按文案生成；故事分析后会自动生成
          Image Prompt。
        </p>
      </div>
      <div className="visual-asset-columns">
        <div>
          <div className="visual-asset-col-head">
            <h4 className="visual-asset-col-title">角色</h4>
            <span className="visual-asset-ratio-badge visual-asset-ratio-badge--required">
              必须 {CHARACTER_REFERENCE_RATIO}
            </span>
          </div>
          <p className="visual-asset-ratio-spec">
            角色形象参考图固定为竖屏 <strong>{CHARACTER_REFERENCE_RATIO}</strong>（推荐 720×1280）。
            AI 生成将自动按此比例输出；本地上传会校验宽高比，不符将无法保存。
          </p>
          <div className="visual-asset-grid">
            {project.characters.map((c) => {
              const refUrl = (c.referenceImageUrl || '').trim() || null;
              const ready = Boolean(refUrl);
              const id = `char:${c.name}`;
              const isBusy = busy === `ai:character:${c.name}`;
              return (
                <div key={c.name} className={`visual-asset-card visual-asset-card--character ${ready ? 'is-ready' : ''}`}>
                  <div className="visual-asset-thumb-wrap visual-asset-thumb-wrap--character">
                    {refUrl ? (
                      <img src={refUrl} alt="" className="visual-asset-thumb visual-asset-thumb--character" />
                    ) : (
                      <div className="visual-asset-thumb-empty visual-asset-thumb-empty--character">无图</div>
                    )}
                    <span className="visual-asset-ratio-tag">{CHARACTER_REFERENCE_RATIO}</span>
                    <span className={`visual-asset-dot ${ready ? 'on' : ''}`} title={ready ? '已设参考' : '未设参考'} />
                  </div>
                  <div className="visual-asset-meta">
                    <span className="visual-asset-name">{c.name}</span>
                    <span className="visual-asset-use-count">用于 {usedByClipCount('character', c.name)} 段情节</span>
                  </div>
                  <p className="visual-asset-desc">
                    {c.description?.slice(0, 80)}
                    {c.description && c.description.length > 80 ? '…' : ''}
                  </p>
                  <PromptEditor
                    kind="character"
                    name={c.name}
                    value={c.imagePrompt || ''}
                    projectId={projectId}
                    episodeId={episodeId}
                    disabled={disabled || Boolean(busy)}
                    onProjectUpdated={onProjectUpdated}
                    onError={onError}
                  />
                  <div className="visual-asset-actions">
                    <button
                      type="button"
                      className="btn-ghost btn-small"
                      disabled={disabled || Boolean(busy)}
                      onClick={() => void handleAi('character', c.name)}
                    >
                      {isBusy ? '…' : 'AI 生成'}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-small"
                      disabled={disabled || Boolean(busy)}
                      onClick={() => fileRef.current[id]?.click()}
                      title={`上传 ${CHARACTER_REFERENCE_RATIO} 竖屏图`}
                    >
                      上传 {CHARACTER_REFERENCE_RATIO}
                    </button>
                    {refUrl ? (
                      <button
                        type="button"
                        className="btn-ghost btn-small"
                        disabled={disabled || Boolean(busy)}
                        onClick={() => void clearRef('character', c.name)}
                      >
                        清除
                      </button>
                    ) : null}
                    <input
                      ref={(el) => {
                        fileRef.current[id] = el;
                      }}
                      type="file"
                      accept="image/*"
                      className="visual-asset-file-input"
                      onChange={(ev) => {
                        const f = ev.target.files?.[0] ?? null;
                        ev.target.value = '';
                        void handleFile('character', c.name, f);
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div>
          <h4 className="visual-asset-col-title">场景</h4>
          <div className="visual-asset-grid">
            {project.locations.map((loc) => {
              const refUrl = (loc.referenceImageUrl || '').trim() || null;
              const ready = Boolean(refUrl);
              const id = `loc:${loc.name}`;
              const isBusy = busy === `ai:location:${loc.name}`;
              return (
                <div key={loc.name} className={`visual-asset-card ${ready ? 'is-ready' : ''}`}>
                  <div className="visual-asset-thumb-wrap">
                    {refUrl ? (
                      <img src={refUrl} alt="" className="visual-asset-thumb" />
                    ) : (
                      <div className="visual-asset-thumb-empty">无图</div>
                    )}
                    <span className={`visual-asset-dot ${ready ? 'on' : ''}`} />
                  </div>
                  <div className="visual-asset-meta">
                    <span className="visual-asset-name">{loc.name}</span>
                    <span className="visual-asset-use-count">用于 {usedByClipCount('location', loc.name)} 段情节</span>
                  </div>
                  <p className="visual-asset-desc">
                    {loc.description?.slice(0, 80)}
                    {loc.description && loc.description.length > 80 ? '…' : ''}
                  </p>
                  <PromptEditor
                    kind="location"
                    name={loc.name}
                    value={loc.imagePrompt || ''}
                    projectId={projectId}
                    episodeId={episodeId}
                    disabled={disabled || Boolean(busy)}
                    onProjectUpdated={onProjectUpdated}
                    onError={onError}
                  />
                  <div className="visual-asset-actions">
                    <button
                      type="button"
                      className="btn-ghost btn-small"
                      disabled={disabled || Boolean(busy)}
                      onClick={() => void handleAi('location', loc.name)}
                    >
                      {isBusy ? '…' : 'AI 生成'}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-small"
                      disabled={disabled || Boolean(busy)}
                      onClick={() => fileRef.current[id]?.click()}
                    >
                      上传
                    </button>
                    {refUrl ? (
                      <button
                        type="button"
                        className="btn-ghost btn-small"
                        disabled={disabled || Boolean(busy)}
                        onClick={() => void clearRef('location', loc.name)}
                      >
                        清除
                      </button>
                    ) : null}
                    <input
                      ref={(el) => {
                        fileRef.current[id] = el;
                      }}
                      type="file"
                      accept="image/*"
                      className="visual-asset-file-input"
                      onChange={(ev) => {
                        const f = ev.target.files?.[0] ?? null;
                        ev.target.value = '';
                        void handleFile('location', loc.name, f);
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
