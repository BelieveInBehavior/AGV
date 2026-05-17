import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchAiSettings, saveAiSettings } from '../../services/settings';
import type { AiSettings } from '../../types/settings';

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState<AiSettings | null>(null);

  const [llmBaseUrl, setLlmBaseUrl] = useState('');
  const [llmModel, setLlmModel] = useState('');
  const [llmApiKey, setLlmApiKey] = useState('');
  const [imageProvider, setImageProvider] = useState<'fal' | 'none' | 'gemini' | 'doubao'>('none');
  const [imageModel, setImageModel] = useState('');
  const [imageApiKey, setImageApiKey] = useState('');
  const [imageSupportsMultiReference, setImageSupportsMultiReference] = useState(false);
  const [imageMaxReferenceImages, setImageMaxReferenceImages] = useState(1);
  const [videoBaseUrl, setVideoBaseUrl] = useState('');
  const [videoModel, setVideoModel] = useState('');
  const [videoApiKey, setVideoApiKey] = useState('');

  useEffect(() => {
    fetchAiSettings()
      .then((s) => {
        setSettings(s);
        setLlmBaseUrl(s.llmBaseUrl);
        setLlmModel(s.llmModel);
        setImageProvider(s.imageProvider);
        setImageModel(s.imageModel);
        setImageSupportsMultiReference(s.imageSupportsMultiReference);
        setImageMaxReferenceImages(s.imageMaxReferenceImages);
        setVideoBaseUrl(s.videoBaseUrl);
        setVideoModel(s.videoModel);
      })
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const payload: Record<string, unknown> = {
        llmBaseUrl,
        llmModel,
        imageProvider,
        imageModel,
        imageSupportsMultiReference,
        imageMaxReferenceImages,
        videoBaseUrl,
        videoModel,
      };
      if (llmApiKey.trim()) payload.llmApiKey = llmApiKey.trim();
      if (imageApiKey.trim()) payload.imageApiKey = imageApiKey.trim();
      if (videoApiKey.trim()) payload.videoApiKey = videoApiKey.trim();

      const next = await saveAiSettings(payload);
      setSettings(next);
      setLlmApiKey('');
      setImageApiKey('');
      setVideoApiKey('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="home-page">
      <header className="home-header">
        <div className="header-inner">
          <h1 className="brand">AI 模型设置</h1>
          <p className="brand-sub">文本 / 生图 / 生视频（OpenAI 兼容与 FAL）</p>
        </div>
        <Link className="btn-primary" to="/" style={{ textDecoration: 'none', display: 'inline-block' }}>
          ← 返回项目
        </Link>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {loading ? (
        <div className="loading-state">加载中...</div>
      ) : (
        <div className="settings-form">
          <section className="settings-section">
            <h2>文本模型（情节分析、分镜）</h2>
            <p className="hint">使用 OpenAI 兼容协议：填写 Base URL、模型名与 API Key（与 Hermes / 各类中转一致）。</p>
            <label className="field">
              <span>LLM Base URL</span>
              <input value={llmBaseUrl} onChange={(e) => setLlmBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
            </label>
            <label className="field">
              <span>模型 ID</span>
              <input value={llmModel} onChange={(e) => setLlmModel(e.target.value)} placeholder="gpt-4o-mini" />
            </label>
            <label className="field">
              <span>API Key {settings?.llmApiKeySet ? <em className="hint">（已保存，留空不变）</em> : null}</span>
              <input
                type="password"
                value={llmApiKey}
                onChange={(e) => setLlmApiKey(e.target.value)}
                placeholder={settings?.llmApiKeySet ? '••••••••' : '必填'}
                autoComplete="off"
              />
            </label>
          </section>

          <section className="settings-section">
            <h2>生图 Provider</h2>
            <p className="hint">FAL 为默认实现；Gemini / Doubao 预留多参考接入（当前仍可能回退为 FAL 单张参考）。</p>
            <label className="field">
              <span>模式</span>
              <select
                value={imageProvider}
                onChange={(e) => setImageProvider(e.target.value as 'fal' | 'none' | 'gemini' | 'doubao')}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #36406a', background: '#0f1428', color: '#eef2ff' }}
              >
                <option value="fal">FAL</option>
                <option value="none">占位图（无 Key）</option>
                <option value="gemini">Gemini（骨架）</option>
                <option value="doubao">豆包（骨架）</option>
              </select>
            </label>
            <label className="field">
              <span>图像模型 ID</span>
              <input value={imageModel} onChange={(e) => setImageModel(e.target.value)} placeholder="fal-ai/flux/schnell" />
            </label>
            <label className="field checkbox-field">
              <span>支持多参考图</span>
              <input
                type="checkbox"
                checked={imageSupportsMultiReference}
                onChange={(e) => setImageSupportsMultiReference(e.target.checked)}
              />
            </label>
            <label className="field">
              <span>最大参考图张数</span>
              <input
                type="number"
                min={1}
                max={16}
                value={imageMaxReferenceImages}
                onChange={(e) => setImageMaxReferenceImages(Number(e.target.value) || 1)}
              />
            </label>
            <label className="field">
              <span>API Key {settings?.imageApiKeySet ? <em className="hint">（已保存）</em> : null}</span>
              <input
                type="password"
                value={imageApiKey}
                onChange={(e) => setImageApiKey(e.target.value)}
                placeholder={settings?.imageApiKeySet ? '••••••••' : '与所选 Provider 一致'}
                autoComplete="off"
              />
            </label>
          </section>

          <section className="settings-section">
            <h2>生视频（预留）</h2>
            <p className="hint">线路与密钥可先保存，接入生成任务后会读取此处配置。</p>
            <label className="field">
              <span>Video API Base URL</span>
              <input value={videoBaseUrl} onChange={(e) => setVideoBaseUrl(e.target.value)} placeholder="将来接入时填写" />
            </label>
            <label className="field">
              <span>视频模型 ID</span>
              <input value={videoModel} onChange={(e) => setVideoModel(e.target.value)} placeholder="" />
            </label>
            <label className="field">
              <span>API Key {settings?.videoApiKeySet ? <em className="hint">（已保存）</em> : null}</span>
              <input
                type="password"
                value={videoApiKey}
                onChange={(e) => setVideoApiKey(e.target.value)}
                placeholder={settings?.videoApiKeySet ? '••••••••' : ''}
                autoComplete="off"
              />
            </label>
          </section>

          <button className="btn-primary" type="button" onClick={handleSave} disabled={saving}>
            {saving ? '保存中…' : '保存设置'}
          </button>
        </div>
      )}
    </div>
  );
}
