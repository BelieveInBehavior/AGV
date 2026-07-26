import { useEffect, useRef, useState } from 'react';
import { CHARACTER_REFERENCE_RATIO } from '../../config/visual-assets';
import type { BeatCharacterPose, Clip, Project, StoryboardPlan } from '../../types/project';
import { generateBeatFrameImage, patchClip, uploadProjectImage } from '../../services/project';
import {
  collectClipReferenceUrls,
  effectiveCharacterRefUrl,
  effectiveLocationRefUrl,
} from './visualRefHelpers';
import { resolveBeatFrames, resolveVideoFirstFrameRef } from './beatPlanHelpers';

function cloneChars(chars: BeatCharacterPose[] | undefined): BeatCharacterPose[] {
  return (chars || []).map((c) => ({
    name: c.name || '',
    outfit: c.outfit || '',
    emotion: c.emotion || '',
  }));
}

function joinLines(items: string[] | undefined | null): string {
  return (items || []).join('\n');
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isHttpUrl(value: string | null | undefined): boolean {
  return Boolean(value && /^https?:\/\//.test(value.trim()));
}

type Props = {
  clip: Clip;
  project: Project;
  projectId: string;
  episodeId: string;
  plan: StoryboardPlan;
  disabled: boolean;
  onClipUpdated: (c: Clip) => void;
  onTaskCreated: (taskId: string, type: 'IMAGE_GENERATION') => void;
  onGenerateVideo: (clipId: string) => Promise<void> | void;
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
  onTaskCreated,
  onGenerateVideo,
  onError,
}: Props) {
  const { first_frame: ff, last_frame: lf } = resolveBeatFrames(plan);
  const videoFirstFrameRef = resolveVideoFirstFrameRef(ff);
  const usingContinuityFrame = Boolean(ff?.continuityImageUrl && ff.continuityImageUrl === videoFirstFrameRef);

  const [videoPrompt, setVideoPrompt] = useState(plan.video_prompt || '');
  const [firstScene, setFirstScene] = useState(ff?.scene_prompt || '');
  const [firstChars, setFirstChars] = useState<BeatCharacterPose[]>(() => cloneChars(ff?.characters));
  const [videoRefUrlsText, setVideoRefUrlsText] = useState(joinLines(clip.videoReferenceAssets?.videoUrls));
  const [audioRefUrlsText, setAudioRefUrlsText] = useState(joinLines(clip.videoReferenceAssets?.audioUrls));
  const [openFirst, setOpenFirst] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generatingFirstFrame, setGeneratingFirstFrame] = useState(false);
  const [generatingVideo, setGeneratingVideo] = useState(false);
  const locFileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const { first_frame: f } = resolveBeatFrames(plan);
    setVideoPrompt(plan.video_prompt || '');
    setFirstScene(f?.scene_prompt || '');
    setFirstChars(cloneChars(f?.characters));
    setVideoRefUrlsText(joinLines(clip.videoReferenceAssets?.videoUrls));
    setAudioRefUrlsText(joinLines(clip.videoReferenceAssets?.audioUrls));
  }, [clip.clipId, clip.videoReferenceAssets, plan]);

  useEffect(() => {
    if (!disabled) setGeneratingFirstFrame(false);
    if (!disabled) setGeneratingVideo(false);
  }, [disabled]);

  const urls = collectClipReferenceUrls(project, clip);
  const trimmedVideoRefUrls = splitLines(videoRefUrlsText);
  const trimmedAudioRefUrls = splitLines(audioRefUrlsText);
  const invalidVideoRefUrls = trimmedVideoRefUrls.filter((url) => !isHttpUrl(url));
  const invalidAudioRefUrls = trimmedAudioRefUrls.filter((url) => !isHttpUrl(url));
  const missingCharacterRefs = clip.characters.filter((name) => !isHttpUrl(effectiveCharacterRefUrl(project, clip, name)));
  const hasBlockingCharacterRefs = missingCharacterRefs.length > 0;
  const hasInvalidMediaRefs = invalidVideoRefUrls.length > 0 || invalidAudioRefUrls.length > 0;

  const persistEdits = async ({ includeVideoReferenceAssets }: { includeVideoReferenceAssets: boolean }) => {
    const body: Parameters<typeof patchClip>[3] = {
      beatPrompts: {
        video_prompt: videoPrompt,
        first_frame: {
          scene_prompt: firstScene,
          description: ff?.description || '',
          characters: firstChars,
        },
      },
    };
    if (includeVideoReferenceAssets) {
      if (hasInvalidMediaRefs) {
        throw new Error('参考视频/音频 URL 仅支持 http/https');
      }
      body.videoReferenceAssets = {
        videoUrls: trimmedVideoRefUrls,
        audioUrls: trimmedAudioRefUrls,
      };
    }
    const updated = await patchClip(projectId, episodeId, clip.clipId, body);
    onClipUpdated(updated);
    return updated;
  };

  const savePrompts = async () => {
    setSaving(true);
    try {
      await persistEdits({ includeVideoReferenceAssets: true });
    } catch (e) {
      onError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleGenerateVideo = async () => {
    if (!videoFirstFrameRef) {
      onError('请先生成首帧图片，再生成视频');
      return;
    }
    if (!videoPrompt.trim() && !firstScene.trim()) {
      onError('视频 Prompt 与首帧 Prompt 至少填写一项，才能生成视频');
      return;
    }
    if (hasBlockingCharacterRefs) {
      onError(`请先补齐角色参考图：${missingCharacterRefs.join('、')}`);
      return;
    }
    if (hasInvalidMediaRefs) {
      onError('参考视频/音频 URL 仅支持 http/https');
      return;
    }
    setSaving(true);
    setGeneratingVideo(true);
    try {
      await persistEdits({ includeVideoReferenceAssets: true });
      await onGenerateVideo(clip.clipId);
    } catch (e) {
      setGeneratingVideo(false);
      onError(e instanceof Error ? e.message : '生成失败');
    } finally {
      setSaving(false);
    }
  };

  const handleGenerateFirstFrame = async () => {
    if (!firstScene.trim()) {
      onError('首帧 Prompt 为空，无法生成图片');
      return;
    }
    setSaving(true);
    setGeneratingFirstFrame(true);
    try {
      await persistEdits({ includeVideoReferenceAssets: false });
      const taskId = await generateBeatFrameImage(projectId, episodeId, clip.clipId, 'first_frame');
      onTaskCreated(taskId, 'IMAGE_GENERATION');
    } catch (e) {
      setGeneratingFirstFrame(false);
      onError(e instanceof Error ? e.message : '生成失败');
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
      const { url } = await uploadProjectImage(projectId, {
        dataUrl,
        fileName: file.name,
        scope: 'clip-reference',
        episodeId,
        clipId: clip.clipId,
      });
      const prev = clip.referenceOverrides || {};
      const updated = await patchClip(projectId, episodeId, clip.clipId, {
        referenceOverrides: {
          characterImages: { ...(prev.characterImages || {}) },
          locationImage: url,
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

  const updateFirstCharRow = (index: number, field: keyof BeatCharacterPose, value: string) => {
    setFirstChars((prev) => {
      const next = [...prev];
      const row = { ...next[index], [field]: value };
      next[index] = row;
      return next;
    });
  };

  const locUrl = effectiveLocationRefUrl(project, clip);
  const hasLocOverride = Boolean((clip.referenceOverrides?.locationImage || '').trim());

  const displayFirst = ff;

  return (
    <div className="beat-keyframe-editor">
      {plan.referenceStale ? (
        <p className="beat-ref-stale">参考图已更新：建议重新点击「生成视频 Prompt」以同步描述。</p>
      ) : null}

      {plan.transition_from_prev ? (
        <p className="beat-continuity">
          <strong>与上一段衔接：</strong>
          {plan.transition_from_prev}
        </p>
      ) : null}

      <div className="beat-prompt-slot beat-video-prompt-slot">
        <div className="beat-prompt-slot-head">
          <strong>视频 Prompt（结构化中文）</strong>
        </div>
        <textarea
          className="beat-prompt-textarea"
          rows={8}
          value={videoPrompt}
          onChange={(e) => setVideoPrompt(e.target.value)}
          disabled={disabled}
        />
      </div>

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
            <strong>首帧 Prompt（静态生图）</strong>
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
                  onChange={(e) => updateFirstCharRow(i, 'outfit', e.target.value)}
                />
                <input
                  className="beat-char-input"
                  placeholder="情绪/动作"
                  value={row.emotion}
                  disabled={disabled}
                  onChange={(e) => updateFirstCharRow(i, 'emotion', e.target.value)}
                />
              </div>
            ))}
          </div>
        </div>
        <div className="beat-prompt-slot beat-video-slot">
          <div className="beat-prompt-slot-head">
            <strong>视频预览</strong>
          </div>
          {clip.videoUrl ? (
            <video src={clip.videoUrl} controls className="clip-video beat-inline-video" playsInline />
          ) : (
            <div className="beat-video-placeholder">
              <span>暂无视频</span>
              <p>当前使用首帧 Prompt、首帧图、视频 Prompt 与参考图直接生成视频，不再单独走尾帧 Prompt 流程。</p>
            </div>
          )}
          <div className="beat-video-ref-block">
            <label className="beat-video-ref-label" htmlFor={`video-refs-${clip.clipId}`}>
              参考视频 URL（每行一个）
            </label>
            <textarea
              id={`video-refs-${clip.clipId}`}
              className="beat-video-ref-textarea"
              rows={3}
              value={videoRefUrlsText}
              onChange={(e) => setVideoRefUrlsText(e.target.value)}
              disabled={disabled}
              placeholder="https://example.com/reference-video.mp4"
            />
            <label className="beat-video-ref-label" htmlFor={`audio-refs-${clip.clipId}`}>
              参考音频 URL（每行一个）
            </label>
            <textarea
              id={`audio-refs-${clip.clipId}`}
              className="beat-video-ref-textarea"
              rows={3}
              value={audioRefUrlsText}
              onChange={(e) => setAudioRefUrlsText(e.target.value)}
              disabled={disabled}
              placeholder="https://example.com/reference-audio.mp3"
            />
          </div>
          <button
            type="button"
            className="btn-primary beat-video-generate-btn"
            disabled={disabled || saving || !videoFirstFrameRef || hasBlockingCharacterRefs || hasInvalidMediaRefs}
            onClick={() => void handleGenerateVideo()}
          >
            {generatingVideo && saving ? '生成中…' : clip.videoUrl ? '重新生成视频' : '生成视频'}
          </button>
          {!videoFirstFrameRef ? <p className="beat-video-note">请先生成首帧图片，再生成视频。</p> : null}
          {usingContinuityFrame ? (
            <p className="beat-video-note">当前将优先使用上一情节尾部抽帧作为首帧参考，以增强跨情节连续性。</p>
          ) : null}
          {hasBlockingCharacterRefs ? (
            <p className="beat-video-note">缺少角色参考图：{missingCharacterRefs.join('、')}</p>
          ) : null}
          {invalidVideoRefUrls.length > 0 ? (
            <p className="beat-video-note">参考视频 URL 非法：{invalidVideoRefUrls.join('、')}</p>
          ) : null}
          {invalidAudioRefUrls.length > 0 ? (
            <p className="beat-video-note">参考音频 URL 非法：{invalidAudioRefUrls.join('、')}</p>
          ) : null}
          {lf?.description ? <p className="beat-video-note">原末帧描述：{lf.description}</p> : null}
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
      <div className="panel-card beat-frame-card beat-first-frame-card">
        {videoFirstFrameRef ? (
          <img src={videoFirstFrameRef} alt="" className="panel-img" />
        ) : (
          <div className="panel-placeholder">
            <span className="shot-label">首帧</span>
          </div>
        )}
        <div className="panel-info">
          <p className="panel-desc">{ff?.description || '首帧图片用于给视频一个更稳定的起始视觉锚点。'}</p>
        </div>
        <button
          type="button"
          className="btn-gen-img"
          disabled={disabled || saving}
          onClick={() => void handleGenerateFirstFrame()}
        >
          {generatingFirstFrame && saving ? '生成中…' : ff?.imageUrl ? '重新生成首帧图片' : '生成首帧图片'}
        </button>
      </div>
      {usingContinuityFrame && !ff?.imageUrl ? (
        <p className="beat-first-note">当前展示的是上一情节视频尾部抽帧得到的连续首帧参考。</p>
      ) : null}
      {displayFirst?.description ? <p className="beat-first-note">首帧描述：{displayFirst.description}</p> : null}
    </div>
  );
}
