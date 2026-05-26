# AGV 手机号登录与 AI 生成任务（前后端分离）

基于 `React + Vite + TypeScript`（前端）、`Express + MongoDB + Redis`（API）和 `Celery + Redis`（Worker）的前后端分离应用。  
登录流程参考了 `/Users/wangxinyu/Desktop/web` 的实现：`/api/auth/send_code`、`/api/auth/verify_code`、`/api/auth/user_info`。AI 生成任务通过 Redis Broker 投递给 Celery Worker 执行，并通过 Redis pub/sub 转发到 SSE。

## 项目结构

```text
AGV/
├── client/                     # 前端应用（Vite + React + TS）
│   ├── src/
│   │   ├── pages/login/        # 手机号验证码登录页
│   │   ├── pages/settings/     # AI 模型设置（文本 / 生图 / 生视频预留）
│   │   ├── pages/project/      # 项目工作台：`index.tsx`、`EpisodeEvaluationPanel.tsx`（质量评估弹窗）、`VisualAssetLibrary.tsx`、`BeatKeyframeEditor.tsx`、`visualRefHelpers.ts`
│   │   ├── config/api.ts       # 开发默认 `/api`（Vite 代理到 CWEI_PORT）；`vite-plugin-agv-api-proxy.ts` 启动校验
│   │   ├── config/visual-assets.ts  # 角色参考图强制 `9:16` 常量与上传宽高比校验
│   │   ├── services/auth.ts    # 登录 API、token；401 时跳转 `/login`
│   │   ├── types/auth.ts       # 登录相关类型定义
│   │   ├── App.tsx             # 路由入口（未登录跳转 /login）
│   │   └── main.tsx
│   └── vite.config.ts          # /api 代理到后端
├── server/                     # API 服务（Express + MongoDB + Redis）
│   ├── src/
│   │   ├── routes/auth.js      # 认证路由
│   │   ├── routes/projects.js # 项目 / 剧集 / clips；参考图与 clip 局部更新
│   │   ├── routes/settings.js  # AI 模型设置（OpenAI 兼容 / FAL）
│   │   ├── utils/
│   │   │   ├── mock-ai-responses.js  # AGV_MOCK_AI=1 时：LLM 固定 JSON + 延迟
│   │   │   ├── pipeline-telemetry.js  # 流水线 JSON 日志 + OTEL（API）
│   │   │   ├── reference-image-fal.js  # 资产库单张参考图（FAL 文生图）
│   │   │   ├── db.js           # Mongo 连接和 users 索引初始化
│   │   │   ├── redis.js        # Redis 客户端、验证码、任务热状态
│   │   │   ├── users.js        # 用户查询和创建
│   │   │   ├── jwt.js          # JWT 生成与鉴权中间件
│   │   │   └── sms.js          # 短信发送（当前开发模式打印验证码）
│   │   ├── queue/task-runner.js # 创建 Mongo 任务并发布 Celery；情节分析入队时写 `episodes.pipelineMetrics`
│   │   ├── config/index.js     # 环境变量配置
│   │   ├── tracing.js          # 可选 OpenTelemetry SDK（OTLP），须先于 app 加载
│   │   └── app.js              # 服务入口
│   └── Dockerfile
├── worker/                     # Celery Worker（Python）
│   ├── tasks/                  # story / beat_prompt / storyboard / image / video
│   ├── skills/                 # LLM Prompt 中文，风格对齐统一规范：`analyze_story`（选角+场景+情节切片）、`generate_beat_frames`、`generate_storyboard`、`generate_transitions`、`multi_ref_image_gen`、`build_image_prompt`、`llm_chat`
│   ├── scripts/                # `evaluate_beat_vs_panels.py`；`clear_storyboard_plans.py`（清空 storyboardPlan 便于重跑）
│   ├── utils/                  # Mongo / Redis；`ai_settings.py`、`reference_assets.py`；`mock_ai.py`（Mock LLM）；`pipeline_telemetry.py`（流水线日志 + OTEL）
│   ├── celery_app.py           # Celery 生产级配置
│   ├── config.py               # Worker 环境变量配置
│   ├── requirements.txt
│   └── Dockerfile
├── docker-compose.yml          # Redis + API + Worker + 可选本地 Mongo；Mongo 连接优先读 `server/.env`
├── scripts/                    # `stress-story-analysis.mjs`：并发 `POST /api/generate/story`（测 Redis `story` 队列 + Worker）
│                               # `video-process.sh`：两段视频拼接+连接处锐化、去人声
├── server/.env.example         # 复制为 `server/.env`：远程库（如 beeseen）或 `mongodb://mongo:27017` 本地联调
├── .env.example                # 与 web 保持一致的核心变量命名
└── README.md
```

## 后端架构

```text
Browser
  ├─ HTTP API ───────────────→ Express API
  └─ EventSource /api/sse ───→ Express SSE

Express API
  ├─ MongoDB: 用户、项目、任务冷数据
  ├─ Redis: 短信验证码、冷却、任务热状态
  └─ Redis Broker: 发布 Celery 任务

Celery Worker
  ├─ Redis Broker: 消费 story/storyboard/image 队列
  ├─ MongoDB: 读取业务数据并写回结果
  └─ Redis pub/sub: 广播任务进度给 SSE
```

生产级约束：

- Redis 使用 AOF 持久化和 `noeviction`，避免队列消息被内存淘汰。
- Celery 使用 `acks_late`、`reject_on_worker_lost`、`prefetch_multiplier=1`、启动重连、软/硬超时。
- 任务状态采用冷热分离：Redis 保存实时状态，Mongo 保存审计与最终状态。
- 短信验证码与发送冷却存入 Redis，支持多 API 实例横向扩展。

## 环境变量（与 web 一致命名）

当前实现使用以下同名变量：

- `MONGODB_URI`
- `MONGODB_DB_NAME`
- `REDIS_URL`
- `JWT_SECRET`
- `JWT_EXPIRES_IN`
- `ALIYUN_SMS_ACCESS_KEY_ID`
- `ALIYUN_SMS_ACCESS_KEY_SECRET`
- `ALIYUN_SMS_SIGN_NAME`
- `ALIYUN_SMS_TEMPLATE_CODE`
- `SMS_CODE_EXPIRE_SECONDS`
- `SEND_CODE_COOLDOWN_SECONDS`
- `TEST_PHONE_NUMBER`
- `TEST_PHONE_CODE`
- `CWEI_PORT`
- `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`（OpenAI 兼容，亦可登录后在「AI 设置」按账号保存）
- `FAL_API_KEY` / `FAL_IMAGE_MODEL`  
- `FAL_IMAGE_I2I_MODEL`（可选，默认 `fal-ai/flux/dev/image-to-image`）：存在参考图时首尾帧/分镜生图优先走图生图，失败回退文生图
- `VIDEO_API_BASE_URL` / `VIDEO_API_KEY` / `VIDEO_MODEL`（预留）
- **`AGV_MOCK_AI`**：**默认关闭**（未设置或空白视为关闭）；设为 `1` / `true` / `yes` / `on` 等任意非 `0` / `false` / `no` / `off` 的值则开启 Mock，所有模型相关调用走 **固定占位 + 约 5s 延迟**（联调无 Key 时用）。走真实 API 时需配置 `LLM_API_KEY`、`FAL_API_KEY` 等，并勿开启 Mock
- **`AGV_MOCK_AI_DELAY_MS`**：Mock 路径下的固定等待（毫秒），默认 `5000`（API 与 Worker 均读取）
- **`CHARACTER_STATE_CACHE_TTL_SECONDS`**：角色状态图 Redis 缓存 TTL（默认 7 天）；MongoDB `characterStates` 集合冷热存储状态图 URL
- `CELERY_TASK_SOFT_TIME_LIMIT`
- `CELERY_TASK_TIME_LIMIT`
- **OpenTelemetry（可选）**  
  - `OTEL_EXPORTER_OTLP_ENDPOINT`：如 `http://localhost:4318`（API / Worker 会拼接 `/v1/traces`）  
  - `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`：完整 traces URL（优先于上一项）  
  - `OTEL_SERVICE_NAME`：如 `agv-api`、`agv-worker`（默认见 `tracing.js` / Worker 内）

### 情节流水线耗时（`episodes.pipelineMetrics` + 日志）

在 **`POST /api/generate/story` 入队** 时，API 会写入 `pipelineMetrics.storyAnalysisSubmittedAt` 等并重置与「首帧图」相关的字段。Worker 在 **情节分析完成** 时写入 `storyAnalysisCompletedAt`、`storyAnalysisDurationMs`，并打一行 JSON 日志：`event: story_analysis_completed`，`phase: novel_input_to_story_parsed`，`durationMs` 为 **从入队到解析完成** 的耗时。

在 **首个首尾帧方案 `first_frame` 生图成功**（`IMAGE_GENERATION` 任务内）时，Worker 写入 `firstBeatFrameImageCompletedAt`、`storyToFirstFrameImageMs`，并打日志：`event: first_beat_first_frame_image_completed`，`phase: story_parsed_to_first_keyframe_image`，`durationMs` 为 **从情节解析完成到首张首帧图就绪** 的耗时（含用户未点「生成 Prompt / 生图」的等待时间）。

上述事件同时会发 **OpenTelemetry span**（若已配置 OTLP）。Worker 需在 **Python 3.8–3.12** 环境安装 `requirements.txt` 中的 `opentelemetry-*`（部分新版本 Python 尚无预编译 wheel 时需降级解释器）。

说明：短信模块已与 `web` 同模式实现（阿里云 Dypnsapi + 开发回退打印），验证码与冷却状态由 Redis 承载。  
文本分析与分镜生成使用 **OpenAI 兼容 Chat Completions**（任意供应商只需提供 Base URL + API Key + 模型 ID，思路与 [Hermes-Agent](https://github.com/NousResearch/Hermes-Agent) 的多 Provider 网关一致）。账号级偏好保存在 MongoDB `user_ai_settings`，入口：**首页 → AI 设置**。  
测试账号默认固定为：`15000361623 / 123456`（对应 `TEST_PHONE_NUMBER`、`TEST_PHONE_CODE`），登录页无需先获取验证码，可直接输入固定验证码登录。

## 启动方式

### 1) 使用 Docker Compose 启动后端依赖与 Worker

```bash
cp .env.example .env
cp server/.env.example server/.env
# 编辑 server/.env：填写 MONGODB_URI、MONGODB_DB_NAME（例如 beeseen，与本地 `npm run dev` 一致）
docker compose up --build
```

该命令会启动：

- `mongo`（可选）: 本地冷数据；宿主机 **`localhost:27018`** → 容器内 `27017`。**`api` / `worker` 不再强制连此服务**：Mongo 地址以 **`server/.env`（覆盖根目录 `.env`）** 为准；若 `server/.env` 指向远程库，可不启动 `mongo`（例如 `docker compose up --build redis api worker`）。
- `redis`: Celery Broker、Result Backend、验证码、任务热状态和 SSE pub/sub
- `api`: Express API；若本机 **3001** 已被占用（例如已在跑 `npm run dev`），Compose 将 API 映射为 **`http://localhost:3011`**（容器内仍为 `3001`）
- `worker`: Celery Worker，监听 `story`、`storyboard`、`image`、`video` 队列（镜像内已设置 `PYTHONPATH=/app` 以加载 `tasks` 包）

### 2) 本地开发启动后端

先确保本地 MongoDB 与 Redis 可用：

```bash
docker compose up mongo redis
```

**环境变量合并：** `server/src/config/index.js` 与 `worker/config.py` 都会按顺序加载 **项目根目录 `.env`** → **`server/.env`**（后者通过 `override` 覆盖同名键）。这样 Mongo / Redis 等与 Celery 读写同一套库；若此前未开启覆盖，会出现「根目录仍是 `agv`、Worker 连不上 API 写入的数据」。

**两套库为何会对不上：** `MONGODB_DB_NAME` 等仍读 **`server/.env` / 根目录 `.env`**。使用 **`docker compose up` 起的 `api` / `worker`** 时，`docker-compose.yml` 会 **强制 `MONGODB_URI=mongodb://mongo:27017`**，避免 `server/.env` 里残留远程 IP 导致容器连错库。本机 **`npm run dev`** 不受该强制项影响，请在 **`server/.env`** 使用 **`mongodb://127.0.0.1:27018`**（或你的本机 Mongo）。若远程与本地混用，会出现「写进 A 库、在 B 库查不到」的现象。远程迁入 Compose Mongo 可用 `mongodump` / `mongorestore`，临时目录 **`.mongo_migrate_dump/`** 已在 `.gitignore`。

启动 API：

```bash
cd server
npm install
npm run dev
```

默认端口：`http://localhost:3001`

启动 Worker：

```bash
cd worker
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m celery -A celery_app worker -Q story,storyboard,image,video --loglevel=INFO
```

### 3) 启动前端

```bash
cd client
npm install
npm run dev
```

默认端口：`http://localhost:3003`

**`/api` 与端口（避免间歇性 404）：**

| 端口 | 服务 |
|------|------|
| **3003** | Vite 前端（浏览器只访问此端口） |
| **3001** | AGV Express API（`CWEI_PORT`，由 Vite 把 `/api` 代理过来） |

- 开发时 **不要** 设置 `VITE_API_ORIGIN`：请求为 `http://localhost:3003/api/...`（同源、无 CORS），代理目标为 `client/.env.development` 里的 **`CWEI_PORT=3001`**。
- **`npm run dev` 启动前** 会执行 `scripts/verify-agv-api.mjs`：确认 3001 上是 AGV（`/health` 返回 `service: "agv-api"`），否则拒绝启动，避免 3001 被其它 Node 项目占用时出现 `Cannot POST /api/projects`。
- **正确启动顺序**：先 VS Code「API (Node)」或 `cd server && npm run dev` → 再 `cd client && npm run dev`。
- 若 API 启动报 `EADDRINUSE`：`lsof -ti :3001 | xargs kill -9` 后只启动本仓库 API。

### 情节分析入队压测（1000 并发 → Redis `story` 队列 + Worker）

1. 登录后拿到 JWT（浏览器 DevTools → Application → 本地存储，或 `verify_code` 响应里的 `token`）。  
2. 在 Mongo 或前端工作台确认该剧集 **`episodeId`**（与 `projectId` 对应）。  
3. 压测队列时可设 **`AGV_MOCK_AI=1`**，避免真实 LLM 限流；默认关闭时 Worker 会打真实模型（注意配额）。  
4. 执行：

```bash
export JWT='<你的 token>'
export EPISODE_ID='<该剧集 episodeId>'
export PROJECT_ID='proj_ad9d740bc5a7'
export API_ORIGIN='http://localhost:3011'
export COUNT=1000
export CONCURRENCY=1000
node scripts/stress-story-analysis.mjs
```

脚本会打印 HTTP 状态分布与耗时摘要。另开终端可看队列深度：`redis-cli LLEN story`（或 `docker compose exec redis redis-cli LLEN story`）。**同一 `episodeId` 并发 1000 次情节分析会互相覆盖写入**，本脚本目的仅为压队列与 Worker；若需数据可重复验证，应准备多集或多项目分批压测。

## 主流程（页面步骤）

1. **输入文本** → `POST /api/generate/story` → 情节与 `clips`（`analyze_story` 完成后会对相邻 clip 做**角色在场回填**：下一段已出场且本段无「进入」描写的角色会补入上一段 `characters`，避免环境镜头漏掉同床配角）  
2. **生成首尾帧 Prompt**（仅 LLM，不写图）→ `POST /api/generate/beat-prompts` → `clips.storyboardPlan` **v2 扁平**：首/末帧含中文 `description`、中文 `scene_prompt`（镜头/场景/动作，无外貌；规则对齐统一分镜规划）、`characters[].outfit/emotion`；衔接字段 `transition_from_prev` 在首批首尾帧图完成后由 Worker 按集批量 LLM 写入（首 clip 为空），`episodes.status` → `beat_prompts_ready`
3. **首尾帧 Prompt 页**：在「视觉资产库」为角色/场景上传或 AI 生成参考图（**角色形象图必须为 9:16**，前端声明并校验上传宽高比；可选本情节 `referenceOverrides`）；可编辑 `scene_prompt` 与角色衣着/情绪并保存。  
4. **生成首尾帧图片** → `POST /api/generate/images`（带 `episodeId`）→ Worker **阶段化**：按 `outfit+emotion` 与基础形象生成/复用 **角色状态图**（Mongo `characterStates` + Redis `cs:{hash}`），再以场景参考 + 状态参考调用 **`multi_ref_image_gen`**（FAL 默认单参考，多参考能力由账号「AI 设置」中 `supportsMultiReference` / `maxReferenceImages` 声明；Gemini/豆包为预留骨架）→ `first_frame.imageUrl` / `last_frame.imageUrl`；完成后 `episodes.status` → `images_ready`  
5. **生成视频** → `POST /api/generate/videos` → 读首尾帧图 URL + 文案（含 `transition_from_prev`）请求视频 API，写入 `clips.videoUrl`，`episodes.status` → `video_ready`  

高级：仍可用 `POST /api/generate/storyboard` 走经典多分镜（`storyboardMode`）；全部分镜为 panel 时完成后仍为 `storyboard_ready`，与首尾帧的 `beat_prompts_ready` 并列进入「Prompt」页展示。

## API

- `POST /api/auth/send_code`  
  请求：`{ "phone_number": "13800138000" }`
- `POST /api/auth/verify_code`  
  请求：`{ "phone_number": "13800138000", "code": "123456" }`
- `GET /api/auth/user_info`  
  请求头：`Authorization: Bearer <token>`  
  前端在受保护接口返回 **401** 或业务体提示 **token 无效 / 已过期 / 未登录** 时，会清除本地 token 并 **`/login` 强制重登**；SSE 异常时也会探测 `user_info` 以同步会话状态。
- `GET /api/projects`  
  列表为**瘦身响应**（避免远程库中单项目文档极大导致长时间无响应）：`description` 超长会截断；`characters` / `locations` 仅返回与库中条数相同的占位元素（供首页展示数量），完整数据请用 `GET /api/projects/:projectId`。
- `GET /api/settings/ai`、`PUT /api/settings/ai`  
  登录用户读写 AI 模型设置：文本 LLM；生图含 `imageProvider`（`fal`|`none`|`gemini`|`doubao`）、`imageSupportsMultiReference`、`imageMaxReferenceImages`；生视频预留。
- `PATCH /api/projects/:projectId/references`  
  请求体可选：`characters` / `locations` 为 `{ name, referenceImageUrl }[]`（`https` 或 `data:image/...`）；可选 `episodeId` 以将当前集 `storyboardPlan.referenceStale` 标为待同步。
- `POST /api/projects/:projectId/references/generate`  
  请求体：`{ "kind": "character"|"location", "name": "...", "episodeId"?: "..." }`，使用账号 FAL 设置生成单张参考图并写回 `projects`。**角色**固定 **9:16**（720×1280）；**场景**跟随项目 `videoRatio`。
- `PATCH /api/projects/:projectId/episodes/:episodeId/clips/:clipId`  
  请求体可选：`referenceOverrides`（`characterImages`、`locationImage`）；`beatPrompts` 设置 `first_frame` / `last_frame` 的 `scene_prompt`、`description`、`characters`。
- `POST /api/generate/story`
- `POST /api/generate/beat-prompts`  
  主流程第二步：为当前集各 `clip` 生成 `storyboardPlan`（`first_frame` / `last_frame` 的 `scene_prompt`、分角色 `outfit`/`emotion` 等），**不生图**。完成后 `episodes.status` = `beat_prompts_ready`。需重跑时可执行 `python3 worker/scripts/clear_storyboard_plans.py --episode-id <id>` 清空后再调本接口。
- `POST /api/generate/storyboard`  
  高级经典分镜。请求体可选：`storyboardMode`: `auto` | `beat_frames` | `panels`。含多分镜时完成后 `storyboard_ready`；若全为首尾帧方案则为 `beat_prompts_ready`。
- `POST /api/generate/images`  
  传入 `episodeId` 且未指定 `panelId`/`panelIds` 时，会为该集内待生成的 panels 以及 **扁平首尾帧** 尚未带图的首、末帧各生成一张图；含角色状态图缓存与 `multi_ref_image_gen`。完成后 `episodes.status` = `images_ready`。
- `POST /api/generate/videos`  
  需 `projectId` + `episodeId`。对已有首尾帧图且尚无 `videoUrl` 的 clip 调用视频 API（`VIDEO_API_BASE_URL` / 用户 AI 设置中的 video；请求体为 JSON：`model`、`prompt`、`first_frame_url`、`last_frame_url`、`aspect_ratio`）。未配置或失败时写入短占位 MP4。完成后 `episodes.status` = `video_ready`。
- `GET /api/tasks/:taskId`
- `GET /api/sse?token=<token>`  
  SSE 事件：`task.progress`、`task.completed`、`task.error`

## 视频后处理工具（从 web 迁移）

新增脚本：`scripts/video-process.sh`

- 拼接并锐化连接处：
  - `scripts/video-process.sh merge <clip_a> <clip_b> <output_mp4> [transition_seconds]`
- 去人声（保留画面）：
  - `scripts/video-process.sh remove-vocals <input_mp4> <output_mp4> [soft|hard]`

说明：`ffmpeg` 去人声属于近似抑制（中置抵消），若源素材人声与伴奏高度重叠，建议改用 AI 分离工具（Demucs/UVR）获得更干净结果。

## 情节分析一直转圈如何排查

前端「情节分析结果」在**有未结束任务**且**还没有任何 clips**时，会显示「AI 正在分析故事结构…」。未结束状态包括：`pending`、`queued`、`running`、`retrying`（只有 `completed` / `failed` 会结束）。

建议按顺序检查：

1. **浏览器开发者工具 → Network**  
   - `POST /api/generate/story` 是否 200，响应里是否有 `taskId`。  
   - 每隔约 2.5 秒的 `GET /api/tasks/<taskId>`：看 `status`、`progress`、`message`、`error`。若长期 `pending`/`queued`，多半是 Worker 未消费队列。  
   - 当 `status` 为 `pending` 或 `queued` 时，同一接口会附带 **`celeryQueue`**：`{ "queue": "story", "backlog": <number> }` 为对应 Celery 队列在 Redis 中的积压条数。`backlog` 长期 **大于 0** 通常表示 **Worker 未启动或未监听该队列**；若 `backlog` 为 **0** 却仍一直 `queued`，请查看 Worker 日志（消息可能已被拉取但解码/执行失败等）。
   - `GET /api/sse?...`（EventSource）：是否连接成功；有无 `task.progress` / `task.completed` / `task.error` 事件（没有 SSE 时仍应靠轮询更新）。

2. **Celery Worker 是否在跑**  
   本地需执行：`python -m celery -A celery_app worker -Q story,storyboard,image,video`。若未启动，任务会一直停在队列里，clips 不会写入。

3. **API 与 Worker 是否指向同一 Redis**  
   两边的 `REDIS_URL` 必须一致（同一 host、db 索引），否则任务发到 A，Worker 连的是 B。

4. **MongoDB 中 `tasks` 集合**  
   用 `taskId` 查文档：`status`、`error`、`message`。Worker 会把最终状态写回 Mongo。

5. **Worker 终端日志**  
   常见原因：`LLM_API_KEY`（或设置页中的文本模型 Key）未配置或无效、Base URL 不可达、LLM 超时；重试耗尽后任务应变为 `failed`，页面应显示失败（若仍卡住，结合第 1 步看轮询是否报错）。

6. **`episodes` 文档的 `status`**  
   分析中会更新为 `analyzing`；成功为 `analyzed` 并写入 `clips`。若长期 `analyzing` 且无 clips，对照 Worker 日志与任务 `error` 字段。

`GET /api/tasks` 与 `GET /api/tasks/:taskId` 的响应中会包含 `projectId`、`episodeId`，便于刷新页面后恢复与某集关联的任务状态。

## 首尾帧 vs 多分镜（离线估算）

对比「每段 2 张首尾帧」与「假设每段 N 张分镜」的估算出图次数：

```bash
python3 worker/scripts/evaluate_beat_vs_panels.py --clips 12 --panels-per-clip 4
```
