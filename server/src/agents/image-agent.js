/**
 * Agent: 图像生成 Agent
 *
 * 无状态设计 — 读取 panel 数据，调用图像 API 生成图片，写回结果
 *
 * 职责:
 *   1. 读取 task → panel → project
 *   2. 使用 buildImagePromptSkill 构建提示词
 *   3. 调用 FAL AI / 其他图像 API
 *   4. 将 imageUrl 写回 panel
 */

import * as fal from '@fal-ai/client';
import { getDB } from '../utils/db.js';
import { broadcastTaskProgress, broadcastTaskComplete, broadcastTaskError } from '../utils/sse.js';
import { buildImagePromptSkill, getResolutionFromRatio } from '../skills/build-image-prompt.js';
import config from '../config/index.js';

// 配置 FAL AI
if (config.fal.apiKey) {
  fal.config({ credentials: config.fal.apiKey });
}

/**
 * 运行图像生成 Agent
 * @param {string} taskId
 */
export async function runImageAgent(taskId) {
  const db = getDB();

  try {
    // ── 1. 读取任务数据 ──────────────────────────────────────────────
    const task = await db.collection('tasks').findOne({ taskId });
    if (!task) throw new Error(`Task ${taskId} not found`);

    const { projectId, episodeId, payload } = task;
    const panelIds = payload?.panelIds;
    const panelId = payload?.panelId;

    const project = await db.collection('projects').findOne({ projectId });
    const artStyle = project?.artStyle || 'cinematic';
    const videoRatio = project?.videoRatio || '16:9';

    // 确定要处理的 panels
    let panels;
    if (panelId) {
      const panel = await db.collection('panels').findOne({ panelId });
      panels = panel ? [panel] : [];
    } else if (panelIds?.length) {
      panels = await db.collection('panels').find({ panelId: { $in: panelIds } }).toArray();
    } else if (episodeId) {
      panels = await db.collection('panels').find({ episodeId, imageUrl: null }).toArray();
    } else {
      throw new Error('No panels specified for image generation');
    }

    if (!panels.length) throw new Error('No panels found for image generation');

    await db.collection('tasks').updateOne(
      { taskId },
      { $set: { status: 'running', progress: 5, message: `开始生成 ${panels.length} 张分镜图片...`, updatedAt: new Date() } }
    );

    // ── 2. 为每个 panel 生成图片 ────────────────────────────────────
    const resolution = getResolutionFromRatio(videoRatio);
    let successCount = 0;

    for (let i = 0; i < panels.length; i++) {
      const panel = panels[i];
      const progress = Math.round(5 + ((i + 1) / panels.length) * 90);

      broadcastTaskProgress(
        taskId,
        progress,
        `正在生成第 ${i + 1}/${panels.length} 张图片...`,
        'generating_image'
      );

      await db.collection('panels').updateOne(
        { panelId: panel.panelId },
        { $set: { status: 'generating_image', updatedAt: new Date() } }
      );

      try {
        // 使用 buildImagePromptSkill 构建优化的提示词
        const { positive, negative } = buildImagePromptSkill({ panel, artStyle, aspectRatio: videoRatio });

        let imageUrl = null;

        if (config.fal.apiKey) {
          // 调用 FAL AI API
          const result = await fal.subscribe(config.fal.imageModel, {
            input: {
              prompt: positive,
              negative_prompt: negative,
              image_size: {
                width: resolution.width,
                height: resolution.height,
              },
              num_inference_steps: 4, // schnell 模型用 4 步
              num_images: 1,
            },
          });

          imageUrl = result?.data?.images?.[0]?.url || result?.images?.[0]?.url || null;
        } else {
          // 没有 FAL API key 时，使用占位图
          imageUrl = `https://placehold.co/${resolution.width}x${resolution.height}/1a1f35/ffffff?text=${encodeURIComponent(panel.description?.slice(0, 30) || 'Panel')}`;
        }

        await db.collection('panels').updateOne(
          { panelId: panel.panelId },
          {
            $set: {
              imageUrl,
              imagePromptUsed: positive,
              status: 'image_ready',
              updatedAt: new Date(),
            },
          }
        );

        successCount++;
      } catch (panelError) {
        // 单个 panel 失败不影响其他 panels
        console.error(`[ImageAgent] Panel ${panel.panelId} failed:`, panelError.message);
        await db.collection('panels').updateOne(
          { panelId: panel.panelId },
          { $set: { status: 'image_failed', imageError: panelError.message, updatedAt: new Date() } }
        );
      }
    }

    // ── 3. 完成任务 ────────────────────────────────────────────
    await db.collection('tasks').updateOne(
      { taskId },
      {
        $set: {
          status: 'completed',
          progress: 100,
          message: `图片生成完成：${successCount}/${panels.length} 张成功`,
          result: { successCount, total: panels.length },
          updatedAt: new Date(),
        },
      }
    );

    broadcastTaskComplete(taskId, { successCount, total: panels.length });
  } catch (error) {
    const errMsg = error?.message || String(error);
    await db.collection('tasks').updateOne(
      { taskId },
      { $set: { status: 'failed', error: errMsg, updatedAt: new Date() } }
    );
    broadcastTaskError(taskId, errMsg);
    throw error;
  }
}
