# 视频剪辑流程实现总结

## 概述
成功添加了视频剪辑功能作为 AGV 多 Agent 分镜视频生成系统的最后一个环节。完整流程现为：
**文本 → 情节分析 → 首尾帧 Prompt → 首尾帧图片 → 视频生成 → 视频剪辑**

## 核心改动

### 1. 前端（Client）

#### 类型定义更新 (`client/src/types/project.ts`)
- **Episode.status** 新增两个状态：`'editing'` 和 `'edited'`
- **Clip** 新增字段：`editedVideoUrl?: string | null`（剪辑后的视频 URL）
- **Task.type** 新增类型：`'VIDEO_EDITING'`

#### 页面流程更新 (`client/src/pages/project/index.tsx`)
- **Stage 类型** 扩展：`'input' | 'clips' | 'prompts' | 'video' | 'editing'`
- **STAGE_ORDER** 更新为 5 个阶段
- **defaultStageForEpisode** 适配新状态：`'editing'` 和 `'edited'`
- **stageUnlocked** 新增编辑阶段的解锁条件
- **handleEditVideos** 函数：触发视频剪辑任务

#### UI 组件新增
- 视频剪辑选项面板：
  - 剪辑策略选择（单独编辑 / 全集拼接）
  - 去人声复选框
  - 过渡时长滑块（仅拼接模式显示）
- 已剪辑视频展示区域
- 步骤条标签 + 任务类型标签更新

#### 服务函数新增 (`client/src/services/project.ts`)
```typescript
export async function editVideos(
  projectId: string,
  episodeId: string,
  options?: { clipIds?: string[]; editOptions?: Record<string, unknown> },
): Promise<string>
```

### 2. API 层（Server）

#### Celery 任务发布器 (`server/src/utils/celery-publisher.js`)
新增方法：
```javascript
async editVideos({ taskId, projectId, episodeId, clipIds = [], editOptions = {} })
```
- 任务名称：`'tasks.edit_video_task.edit_videos'`
- 目标队列：`'video'`（与生视频共用队列）

#### 任务入队器 (`server/src/queue/task-runner.js`)
- 任务类型新增：`'VIDEO_EDITING'`
- enqueueTask 函数支持该类型的投递

#### 生成路由 (`server/src/routes/generate.js`)
新增端点：
```
POST /api/generate/edit-videos
请求体：{
  projectId: string,
  episodeId: string,
  clipIds?: string[],
  editOptions?: {
    strategy: 'individual' | 'compile',
    removeVocals: boolean | 'soft' | 'hard',
    transitionDuration: number
  }
}
```

### 3. Worker 层（Python Celery）

#### 新任务模块 (`worker/tasks/edit_video_task.py`)
完整视频后处理实现，支持：

**核心功能：**
- **单独编辑** (`strategy='individual'`)：逐个 clip 处理
- **全集拼接** (`strategy='compile'`)：多 clip 淡入淡出过渡 + 锐化连接处
- **去人声处理**：中置抵消法（软/硬强度）
- **视频转码**：自动缩放至 480p 节省存储
- **OSS 上传**：视频持久化存储

**关键函数：**
- `_merge_clips()` - ffmpeg 拼接（淡入淡出过渡 + 连接处锐化）
- `_remove_vocals()` - 去人声处理
- `_download_to_temp_file()` - 下载视频到临时文件
- `_persist_video_to_oss()` - 上传至 OSS
- `_transcode_to_480p()` - 转码为 480P

**Celery 任务：**
```python
@app.task(name='tasks.edit_video_task.edit_videos', queue='video')
def edit_videos(
    task_id: str,
    project_id: str,
    episode_id: str,
    clip_ids: list = None,
    edit_options: dict = None
)
```

**数据持久化：**
- `clips.editedVideoUrl`：个人视频或全集拼接后的 URL
- `episodes.compiledVideoUrl`：全集完整视频 URL（拼接模式）
- `episodes.status` → `'edited'`（全集拼接时更新）

#### Celery 配置更新 (`worker/celery_app.py`)
- 任务路由新增：`'tasks.edit_video_task.*': {'queue': 'video'}`

#### 任务自动发现 (`worker/tasks/tasks.py`)
- 导入 `edit_video_task` 模块

## 工作流示例

### 场景 1：单独编辑各情节
```
用户在「视频剪辑」页选择：
  - 策略：单独编辑各情节
  - 去人声：✓ (soft)
  ↓
API POST /api/generate/edit-videos
  ↓
Worker 逐个处理每个 clip：
  1. 下载 clip.videoUrl
  2. 去人声处理
  3. 转码 480p
  4. 上传 OSS → clip.editedVideoUrl
```

### 场景 2：全集拼接（推荐）
```
用户在「视频剪辑」页选择：
  - 策略：全集拼接
  - 去人声：✓ (soft)
  - 过渡时长：0.5s
  ↓
API POST /api/generate/edit-videos
  ↓
Worker 执行：
  1. 下载所有 clips 视频
  2. 按 clipIndex 顺序拼接：
     - 淡入淡出过渡（0.5s）
     - 连接处锐化（unsharp filter）
  3. 去人声处理
  4. 转码 480p
  5. 上传 OSS → clips[*].editedVideoUrl + episodes.compiledVideoUrl
  6. 更新 episodes.status = 'edited'
```

## 数据库改动

### MongoDB 更新
**clips 集合：**
```javascript
{
  clipId: "clip_xxx",
  videoUrl: "https://...",           // 原始生成视频
  editedVideoUrl: "https://...",     // 新增：剪辑后视频
  // ... 其他字段
}
```

**episodes 集合：**
```javascript
{
  episodeId: "ep_xxx",
  status: "edited",                   // 新增状态值
  compiledVideoUrl: "https://...",   // 新增：全集拼接后视频（编译模式）
  // ... 其他字段
}
```

## 前后端通信

### SSE 事件
视频剪辑任务进度通过 SSE 实时推送：
```json
{
  "type": "task.progress",
  "taskId": "task_xxx",
  "progress": 45,
  "message": "编辑视频 2/3: 拼接视频片段...",
  "stage": "merging_clips"
}
```

### 轮询机制
前端每 2.5 秒查询 `/api/tasks/:taskId` 获取任务状态，确保 SSE 故障时仍能更新。

## 后续可扩展性

### 预留的剪辑选项结构
```javascript
editOptions: {
  strategy: 'individual' | 'compile',
  removeVocals: boolean | 'soft' | 'hard',
  transitionDuration: number,
  // 预留字段：
  // - watermarkText?: string          // 水印文字
  // - overlayAudioUrl?: string        // 背景音乐 URL
  // - colorGrading?: 'warm' | 'cool'  // 色彩分级
}
```

### 可选增强方向
1. **高级色彩处理**：集成 OpenCV 或专业色彩库
2. **字幕嵌入**：根据 clip 情节自动生成和嵌入字幕
3. **背景音乐**：上传或 AI 生成背景音乐并合成
4. **多格式输出**：支持不同分辨率/编码方案的导出
5. **实时预览**：WebGL 加速的浏览器端预览编辑

## 测试建议

### 单元测试
- ffmpeg 命令构造正确性
- OSS 上传失败回退机制
- 数据库写回幂等性

### 集成测试
1. 创建项目 → 分析文本 → 生成视频 → 剪辑
2. 验证 clips.editedVideoUrl 和 episodes.compiledVideoUrl 正确写入
3. 测试网络中断时任务重试机制

### 性能测试
- 多个 clip 的并发编辑（Worker prefetch 设为 1）
- 大视频文件拼接（测试临时文件清理）
- ffmpeg 转码性能基准

## 部署检查清单

- [ ] 安装 ffmpeg（`brew install ffmpeg` 或 Docker 镜像内预装）
- [ ] 配置 FFMPEG_BIN 环境变量（如使用自定义路径）
- [ ] 确保 Worker 启动时监听 `video` 队列
- [ ] 验证 OSS 存储桶权限配置
- [ ] 测试 Redis Broker 连接
- [ ] 确认 MongoDB `clips` 和 `episodes` 集合已同步新字段索引

## 文件清单

### 新增
- `worker/tasks/edit_video_task.py` - 核心编辑任务实现

### 修改
- `client/src/types/project.ts` - 类型定义
- `client/src/pages/project/index.tsx` - UI 流程
- `client/src/services/project.ts` - API 调用
- `server/src/utils/celery-publisher.js` - 任务发布
- `server/src/queue/task-runner.js` - 任务入队
- `server/src/routes/generate.js` - API 端点
- `worker/celery_app.py` - 任务路由
- `worker/tasks/tasks.py` - 任务自动发现

## 总结

视频剪辑功能完全集成到既有的多 Agent 无状态架构中，遵循：
- **队列解耦**：使用 Redis Broker，Worker 独立消费
- **进度实时**：SSE + 轮询双重保障
- **冗错机制**：任务自动重试、临时文件清理
- **成本优化**：480p 自动转码、ffmpeg 高效处理

用户可在最后一步对生成的视频进行灵活的后期剪辑和处理，完成从文本到完整视频的端到端自动化流程。
