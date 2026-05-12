import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listProjects, createProject } from '../../services/project';
import type { Project } from '../../types/project';

const ART_STYLES = [
  { value: 'cinematic', label: '电影风格' },
  { value: 'realistic', label: '写实风格' },
  { value: 'anime', label: '动漫风格' },
  { value: 'american-comic', label: '美漫风格' },
  { value: 'watercolor', label: '水彩风格' },
];

const RATIOS = [
  { value: '16:9', label: '横屏 16:9' },
  { value: '9:16', label: '竖屏 9:16' },
  { value: '1:1', label: '方形 1:1' },
];

export default function HomePage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: '',
    description: '',
    artStyle: 'cinematic',
    videoRatio: '16:9',
    language: 'zh',
  });
  const [error, setError] = useState('');

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleCreate = async () => {
    if (!form.name.trim()) { setError('请输入项目名称'); return; }
    setCreating(true);
    setError('');
    try {
      const project = await createProject(form);
      navigate(`/project/${project.projectId}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '创建失败');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="home-page">
      <header className="home-header">
        <div className="header-inner">
          <h1 className="brand">🎬 AGV Studio</h1>
          <p className="brand-sub">文本 → 分镜 → 图片 → 视频</p>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Link className="btn-primary" to="/settings" style={{ textDecoration: 'none', display: 'inline-block' }}>
            AI 设置
          </Link>
          <button className="btn-primary" onClick={() => setShowCreate(true)}>
            + 新建项目
          </button>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {/* 项目列表 */}
      {loading ? (
        <div className="loading-state">加载中...</div>
      ) : projects.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🎥</div>
          <p>还没有项目，点击「新建项目」开始创作</p>
          <button className="btn-primary" onClick={() => setShowCreate(true)}>
            + 新建项目
          </button>
        </div>
      ) : (
        <div className="project-grid">
          {projects.map((p) => (
            <div
              key={p.projectId}
              className="project-card"
              onClick={() => navigate(`/project/${p.projectId}`)}
            >
              <div className="project-card-top">
                <span className="art-badge">{ART_STYLES.find(s => s.value === p.artStyle)?.label || p.artStyle}</span>
                <span className="ratio-badge">{p.videoRatio}</span>
              </div>
              <h3 className="project-name">{p.name}</h3>
              {p.description && <p className="project-desc">{p.description}</p>}
              <div className="project-meta">
                <span>{p.characters.length} 个角色</span>
                <span>{p.locations.length} 个场景</span>
                <span>{new Date(p.updatedAt).toLocaleDateString('zh-CN')}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 新建项目弹窗 */}
      {showCreate && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowCreate(false)}>
          <div className="modal">
            <h2 className="modal-title">新建项目</h2>

            <div className="form-group">
              <label>项目名称 *</label>
              <input
                className="form-input"
                placeholder="例如：都市爱情短剧"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>

            <div className="form-group">
              <label>项目描述</label>
              <input
                className="form-input"
                placeholder="简短描述项目内容（可选）"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>艺术风格</label>
                <select
                  className="form-select"
                  value={form.artStyle}
                  onChange={(e) => setForm({ ...form, artStyle: e.target.value })}
                >
                  {ART_STYLES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>画面比例</label>
                <select
                  className="form-select"
                  value={form.videoRatio}
                  onChange={(e) => setForm({ ...form, videoRatio: e.target.value })}
                >
                  {RATIOS.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {error && <div className="error-msg">{error}</div>}

            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setShowCreate(false)}>取消</button>
              <button className="btn-primary" onClick={handleCreate} disabled={creating}>
                {creating ? '创建中...' : '创建项目'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
