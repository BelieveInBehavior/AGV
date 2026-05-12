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
│   │   ├── services/auth.ts    # 登录 API 与 token 本地存储
│   │   ├── types/auth.ts       # 登录相关类型定义
│   │   ├── App.tsx             # 路由入口（未登录跳转 /login）
│   │   └── main.tsx
│   └── vite.config.ts          # /api 代理到后端
├── server/                     # API 服务（Express + MongoDB + Redis）
│   ├── src/
│   │   ├── routes/auth.js      # 认证路由
│   │   ├── routes/settings.js  # AI 模型设置（OpenAI 兼容 / FAL）
│   │   ├── utils/
│   │   │   ├── db.js           # Mongo 连接和 users 索引初始化
│   │   │   ├── redis.js        # Redis 客户端、验证码、任务热状态
│   │   │   ├── users.js        # 用户查询和创建
│   │   │   ├── jwt.js          # JWT 生成与鉴权中间件
│   │   │   └── sms.js          # 短信发送（当前开发模式打印验证码）
│   │   ├── queue/task-runner.js # 创建 Mongo 任务并发布 Celery 消息
│   │   ├── config/index.js     # 环境变量配置
│   │   └── app.js              # 服务入口
│   └── Dockerfile
├── worker/                     # Celery Worker（Python）
│   ├── tasks/                  # story / storyboard / image 任务（`tasks/tasks.py` 聚合模块供 Celery autodiscover）
│   ├── utils/                  # Mongo / Redis；`ai_settings.py`、`skills/llm_chat.py`（OpenAI 兼容）
│   ├── celery_app.py           # Celery 生产级配置
│   ├── config.py               # Worker 环境变量配置
│   ├── requirements.txt
│   └── Dockerfile
├── docker-compose.yml          # Mongo + Redis + API + Worker
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
- `VIDEO_API_BASE_URL` / `VIDEO_API_KEY` / `VIDEO_MODEL`（预留）
- `CELERY_WORKER_CONCURRENCY`
- `CELERY_TASK_SOFT_TIME_LIMIT`
- `CELERY_TASK_TIME_LIMIT`

说明：短信模块已与 `web` 同模式实现（阿里云 Dypnsapi + 开发回退打印），验证码与冷却状态由 Redis 承载。  
文本分析与分镜生成使用 **OpenAI 兼容 Chat Completions**（任意供应商只需提供 Base URL + API Key + 模型 ID，思路与 [Hermes-Agent](https://github.com/NousResearch/Hermes-Agent) 的多 Provider 网关一致）。账号级偏好保存在 MongoDB `user_ai_settings`，入口：**首页 → AI 设置**。  
测试账号默认固定为：`15000361623 / 123456`（对应 `TEST_PHONE_NUMBER`、`TEST_PHONE_CODE`），登录页无需先获取验证码，可直接输入固定验证码登录。

## 启动方式

### 1) 使用 Docker Compose 启动后端依赖与 Worker

```bash
cp .env.example .env
docker compose up --build
```

该命令会启动：

- `mongo`: 冷数据存储
- `redis`: Celery Broker、Result Backend、验证码、任务热状态和 SSE pub/sub
- `api`: Express API，默认端口 `http://localhost:3001`
- `worker`: Celery Worker，监听 `story`、`storyboard`、`image` 队列

### 2) 本地开发启动后端

先确保本地 MongoDB 与 Redis 可用：

```bash
docker compose up mongo redis
```

**环境变量合并：** `server/src/config/index.js` 与 `worker/config.py` 都会按顺序加载 **项目根目录 `.env`** → **`server/.env`**（后者通过 `override` 覆盖同名键）。这样 Mongo / Redis 等与 Celery 读写同一套库；若此前未开启覆盖，会出现「根目录仍是 `agv`、Worker 连不上 API 写入的数据」。

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
python -m celery -A celery_app worker -Q story,storyboard,image --loglevel=INFO
```

### 3) 启动前端

```bash
cd client
npm install
npm run dev
```

默认端口：`http://localhost:3003`

## API

- `POST /api/auth/send_code`  
  请求：`{ "phone_number": "13800138000" }`
- `POST /api/auth/verify_code`  
  请求：`{ "phone_number": "13800138000", "code": "123456" }`
- `GET /api/auth/user_info`  
  请求头：`Authorization: Bearer <token>`
- `GET /api/settings/ai`、`PUT /api/settings/ai`  
  登录用户读写 AI 模型设置（文本 / FAL 生图 / 生视频预留）
- `POST /api/generate/story`
- `POST /api/generate/storyboard`
- `POST /api/generate/images`
- `GET /api/tasks/:taskId`
- `GET /api/sse?token=<token>`  
  SSE 事件：`task.progress`、`task.completed`、`task.error`

## 情节分析一直转圈如何排查

前端「情节分析结果」在**有未结束任务**且**还没有任何 clips**时，会显示「AI 正在分析故事结构…」。未结束状态包括：`pending`、`queued`、`running`、`retrying`（只有 `completed` / `failed` 会结束）。

建议按顺序检查：

1. **浏览器开发者工具 → Network**  
   - `POST /api/generate/story` 是否 200，响应里是否有 `taskId`。  
   - 每隔约 2.5 秒的 `GET /api/tasks/<taskId>`：看 `status`、`progress`、`message`、`error`。若长期 `pending`/`queued`，多半是 Worker 未消费队列。  
   - 当 `status` 为 `pending` 或 `queued` 时，同一接口会附带 **`celeryQueue`**：`{ "queue": "story", "backlog": <number> }` 为对应 Celery 队列在 Redis 中的积压条数。`backlog` 长期 **大于 0** 通常表示 **Worker 未启动或未监听该队列**；若 `backlog` 为 **0** 却仍一直 `queued`，请查看 Worker 日志（消息可能已被拉取但解码/执行失败等）。
   - `GET /api/sse?...`（EventSource）：是否连接成功；有无 `task.progress` / `task.completed` / `task.error` 事件（没有 SSE 时仍应靠轮询更新）。

2. **Celery Worker 是否在跑**  
   本地需执行：`python -m celery -A celery_app worker -Q story,storyboard,image`。若未启动，任务会一直停在队列里，clips 不会写入。

3. **API 与 Worker 是否指向同一 Redis**  
   两边的 `REDIS_URL` 必须一致（同一 host、db 索引），否则任务发到 A，Worker 连的是 B。

4. **MongoDB 中 `tasks` 集合**  
   用 `taskId` 查文档：`status`、`error`、`message`。Worker 会把最终状态写回 Mongo。

5. **Worker 终端日志**  
   常见原因：`LLM_API_KEY`（或设置页中的文本模型 Key）未配置或无效、Base URL 不可达、LLM 超时；重试耗尽后任务应变为 `failed`，页面应显示失败（若仍卡住，结合第 1 步看轮询是否报错）。

6. **`episodes` 文档的 `status`**  
   分析中会更新为 `analyzing`；成功为 `analyzed` 并写入 `clips`。若长期 `analyzing` 且无 clips，对照 Worker 日志与任务 `error` 字段。

`GET /api/tasks` 与 `GET /api/tasks/:taskId` 的响应中会包含 `projectId`、`episodeId`，便于刷新页面后恢复与某集关联的任务状态。
