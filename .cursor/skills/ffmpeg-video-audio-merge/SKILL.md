---
name: ffmpeg-video-audio-merge
description: AGV video post-processing helpers for clip merge, seam sharpening, and vocal reduction.
---

# FFmpeg 视频后处理（AGV）

迁移来源：`web` 项目中的手工 ffmpeg 拼接/去人声流程。  
推荐优先使用脚本：`scripts/video-process.sh`。

## 可用命令

### 1) 两段视频拼接 + 连接处锐化

```bash
scripts/video-process.sh merge <clip_a> <clip_b> <output_mp4> [transition_seconds]
```

- 视频：`xfade`
- 音频：`acrossfade`
- 连接处：`unsharp` 仅在过渡窗口内增强

### 2) 去人声（保留画面）

```bash
scripts/video-process.sh remove-vocals <input_mp4> <output_mp4> [soft|hard]
```

- `soft`：弱中置抑制，保留伴奏更多（默认）
- `hard`：强中置抵消，可能更干净但容易损伤伴奏

## 依赖

- `ffmpeg`
- `ffprobe`

## 注意

- `ffmpeg` 方案是近似去人声，不保证完全清除；若需高质量分离，请用 Demucs / UVR 类 AI 分离流程。
