import { useEffect, useRef, useState } from 'react';
import { CHARACTER_REFERENCE_RATIO } from '../../config/visual-assets';
import type { BeatCharacterPose, Clip, Project, StoryboardPlan } from '../../types/project';
import { patchClip } from '../../services/project';
import {
  collectClipReferenceUrls,
  effectiveCharacterRefUrl,
  effectiveLocationRefUrl,
} from './visualRefHelpers';
import { resolveBeatFrames } from './beatPlanHelpers';

function cloneChars(chars: BeatCharacterPose[] | undefined): BeatCharacterPose[] {
  return (chars || []).map((c) => ({
    name: c.name || '',
    outfit: c.outfit || '',
    emotion: c.emotion || '',
  }));
}

type Props = {
  clip: Clip;
  project: Project;
  projectId: string;
  episodeId: string;
  plan: StoryboardPlan;
  disabled: boolean;
  onClipUpdated: (c: Clip) => void;
  onError: (msg: string) => void;
};

export function BeatKeyframeEditor({
  clip,
  project,
  projectId,
  episodeId,
  plan,
  disabled,
  onClipUpdated,
  onError,
}: Props) {
  const { first_frame: ff, last_frame: lf } = resolveBeatFrames(plan);

  const [firstScene, setFirstScene] = useState(ff?.scene_prompt || ff?.imagePrompt || '');
  const [lastScene, setLastScene] = useState(lf?.scene_prompt || lf?.imagePrompt || '');
  const [firstChars, setFirstChars] = useState<BeatCharacterPose[]>(() => cloneChars(ff?.characters));
  const [lastChars, setLastChars] = useState<BeatCharacterPose[]>(() => cloneChars(lf?.characters));
  const [openFirst, setOpenFirst] = useState(false);
  const [openLast, setOpenLast] = useState(false);
  const [saving, setSaving] = useState(false);
  const locFileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const { first_frame: f, last_frame: l } = resolveBeatFrames(plan);
    setFirstScene(f?.scene_prompt || f?.imagePrompt || '');
    setLastScene(l?.scene_prompt || l?.imagePrompt || '');
    setFirstChars(cloneChars(f?.characters));
    setLastChars(cloneChars(l?.characters));
  }, [clip.clipId, plan]);

  const urls = collectClipReferenceUrls(project, clip);

  const savePrompts = async () => {
    setSaving(true);
    try {
      const updated = await patchClip(projectId, episodeId, clip.clipId, {
        beatPrompts: {
          first_frame: {
            scene_prompt: firstScene,
            description: ff?.description || '',
            characters: firstChars,
          },
          last_frame: {
            scene_prompt: lastScene,
            description: lf?.description || '',
            characters: lastChars,
          },
        },
      });
      onClipUpdated(updated);
    } catch (e) {
      onError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const clearLocationOverride = async () => {
    setSaving(true);
    try {
      const prev = clip.referenceOverrides || {};
      const updated = await patchClip(projectId, episodeId, clip.clipId, {
        referenceOverrides: {
          characterImages: { ...(prev.characterImages || {}) },
          locationImage: null,
        },
      });
      onClipUpdated(updated);
    } catch (e) {
      onError(e instanceof Error ? e.message : '清除失败');
    } finally {
      setSaving(false);
    }
  };

  const uploadLocationOverride = async (file: File | null) => {
    if (!file) return;
    setSaving(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => reject(new Error('读取失败'));
        r.readAsDataURL(file);
      });
      if (!dataUrl.startsWith('data:image/')) throw new Error('请选择图片');
      const prev = clip.referenceOverrides || {};
      const updated = await patchClip(projectId, episodeId, clip.clipId, {
        referenceOverrides: {
          characterImages: { ...(prev.characterImages || {}) },
          locationImage: dataUrl,
        },
      });
      onClipUpdated(updated);
    } catch (e) {
      onError(e instanceof Error ? e.message : '上传失败');
    } finally {
      setSaving(false);
    }
  };

  const clearCharOverride = async (name: string) => {
    setSaving(true);
    try {
      const prev = { ...(clip.referenceOverrides?.characterImages || {}) };
      delete prev[name];
      const updated = await patchClip(projectId, episodeId, clip.clipId, {
        referenceOverrides: {
          characterImages: prev,
          locationImage: clip.referenceOverrides?.locationImage ?? null,
        },
      });
      onClipUpdated(updated);
    } catch (e) {
      onError(e instanceof Error ? e.message : '清除失败');
    } finally {
      setSaving(false);
    }
  };

  const updateCharRow = (
    which: 'first' | 'last',
    index: number,
    field: keyof BeatCharacterPose,
    value: string,
  ) => {
    const setter = which === 'first' ? setFirstChars : setLastChars;
    setter((prev) => {
      const next = [...prev];
      const row = { ...next[index], [field]: value };
      next[index] = row;
      return next;
    });
  };

  const locUrl = effectiveLocationRefUrl(project, clip);
  const hasLocOverride = Boolean((clip.referenceOverrides?.locationImage || '').trim());

  const displayFirst = ff;
  const displayLast = lf;

  return (
    <div className="beat-keyframe-editor">
      {plan.referenceStale ? (
        <p className="beat-ref-stale">参考图已更新：建议重新点击「生成首尾帧 Prompt」以同步描述。</p>
      ) : null}

      {plan.transition_from_prev ? (
        <p className="beat-continuity">
          <strong>与上一段衔接：</strong>
          {plan.transition_from_prev}
        </p>
      ) : null}

      <div className="beat-ref-chips">
        <span className="beat-ref-chips-label">本情节引用</span>
        <div className="beat-ref-chip-row">
          <span className="beat-ref-chip loc">
            <span className="beat-ref-chip-label">场景</span>
            {locUrl ? <img src={locUrl} alt="" className="beat-ref-chip-img" /> : <span className="beat-ref-miss">缺</span>}
            <span>{clip.location}</span>
            {hasLocOverride ? (
              <button type="button" className="btn-ghost btn-tiny" disabled={disabled || saving} onClick={() => void clearLocationOverride()}>
                清除本段覆盖
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn-ghost btn-tiny"
                  disabled={disabled || saving}
                  onClick={() => locFileRef.current?.click()}
                >
                  本段覆盖图
                </button>
                <input
                  ref={locFileRef}
                  type="file"
                  accept="image/*"
                  className="visual-asset-file-input"
                  onChange={(ev) => {
                    const f = ev.target.files?.[0] ?? null;
                    ev.target.value = '';
                    void uploadLocationOverride(f);
                  }}
                />
              </>
            )}
          </span>
          {clip.characters.map((cn) => {
            const u = effectiveCharacterRefUrl(project, clip, cn);
            const hasOv = Boolean((clip.referenceOverrides?.characterImages?.[cn] || '').trim());
            return (
              <span key={cn} className="beat-ref-chip">
                {u ? <img src={u} alt="" className="beat-ref-chip-img" /> : <span className="beat-ref-miss">缺</span>}
                <span>{cn}</span>
                {hasOv ? (
                  <button
                    type="button"
                    className="btn-ghost btn-tiny"
                    disabled={disabled || saving}
                    onClick={() => void clearCharOverride(cn)}
                  >
                    清除覆盖
                  </button>
                ) : null}
              </span>
            );
          })}
        </div>
        {clip.characters.length > 0 ? (
          <span className="beat-ref-ratio-note">
            角色形象参考图须为 {CHARACTER_REFERENCE_RATIO}（在上方视觉资产库设置）
          </span>
        ) : null}
        <span className="beat-ref-url-count">参考图序列（Worker）：{urls.length} 张</span>
      </div>

      <div className="beat-prompt-edit-grid">
        <div className="beat-prompt-slot">
          <div className="beat-prompt-slot-head">
            <strong>首帧 scene_prompt（EN，无外貌描写）</strong>
            <button type="button" className="btn-ghost btn-tiny" onClick={() => setOpenFirst((v) => !v)}>
              {openFirst ? '收起' : '展开编辑'}
            </button>
          </div>
          {openFirst ? (
            <textarea
              className="beat-prompt-textarea"
              rows={6}
              value={firstScene}
              onChange={(e) => setFirstScene(e.target.value)}
              disabled={disabled}
            />
          ) : (
            <pre className="prompt-en-pre beat-prompt-collapsed">{firstScene || '—'}</pre>
          )}
          <div className="beat-char-edit-block">
            <span className="beat-char-edit-label">角色状态（首帧）</span>
            {firstChars.map((row, i) => (
              <div key={`${row.name}-${i}`} className="beat-char-edit-row">
                <span className="beat-char-name">{row.name || '—'}</span>
                <input
                  className="beat-char-input"
                  placeholder="衣着"
                  value={row.outfit}
                  disabled={disabled}
                  onChange={(e) => updateCharRow('first', i, 'outfit', e.target.value)}
                />
                <input
                  className="beat-char-input"
                  placeholder="情绪/动作"
                  value={row.emotion}
                  disabled={disabled}
                  onChange={(e) => updateCharRow('first', i, 'emotion', e.target.value)}
                />
              </div>
            ))}
          </div>
        </div>
        <div className="beat-prompt-slot">
          <div className="beat-prompt-slot-head">
            <strong>末帧 scene_prompt（EN，无外貌描写）</strong>
            <button type="button" className="btn-ghost btn-tiny" onClick={() => setOpenLast((v) => !v)}>
              {openLast ? '收起' : '展开编辑'}
            </button>
          </div>
          {openLast ? (
            <textarea
              className="beat-prompt-textarea"
              rows={6}
              value={lastScene}
              onChange={(e) => setLastScene(e.target.value)}
              disabled={disabled}
            />
          ) : (
            <pre className="prompt-en-pre beat-prompt-collapsed">{lastScene || '—'}</pre>
          )}
          <div className="beat-char-edit-block">
            <span className="beat-char-edit-label">角色状态（末帧）</span>
            {lastChars.map((row, i) => (
              <div key={`${row.name}-l-${i}`} className="beat-char-edit-row">
                <span className="beat-char-name">{row.name || '—'}</span>
                <input
                  className="beat-char-input"
                  placeholder="衣着"
                  value={row.outfit}
                  disabled={disabled}
                  onChange={(e) => updateCharRow('last', i, 'outfit', e.target.value)}
                />
                <input
                  className="beat-char-input"
                  placeholder="情绪/动作"
                  value={row.emotion}
                  disabled={disabled}
                  onChange={(e) => updateCharRow('last', i, 'emotion', e.target.value)}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="beat-prompt-save-row">
        <button
          type="button"
          className="btn-primary btn-small"
          disabled={disabled || saving}
          onClick={() => void savePrompts()}
        >
          {saving ? '保存中…' : '保存 Prompt 修改'}
        </button>
      </div>

      <div className="panels-row beat-pair-row">
        <div className="panel-card beat-frame-card">
          {ff?.imageUrl ? (
            <img src={ff.imageUrl} alt="" className="panel-img" />
          ) : (
            <div className="panel-placeholder">
              <span className="shot-label">首帧</span>
            </div>
          )}
          <div className="panel-info">
            <p className="panel-desc">{ff?.description}</p>
          </div>
        </div>
        <div className="panel-card beat-frame-card">
          {lf?.imageUrl ? (
            <img src={lf.imageUrl} alt="" className="panel-img" />
          ) : (
            <div className="panel-placeholder">
              <span className="shot-label">末帧</span>
            </div>
          )}
          <div className="panel-info">
            <p className="panel-desc">{lf?.description}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
