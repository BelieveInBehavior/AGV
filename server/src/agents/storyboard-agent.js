/**
 * Agent: 分镜生成 Agent
 *
 * 无状态设计 — 从 MongoDB 读取 clip 数据，调用 LLM 生成面板，写回结果
 *
 * 职责:
 *   1. 读取 task → clip → project (角色/场景)
 *   2. 调用 generateStoryboardSkill (LLM)
 *   3. 将 panels 写入 MongoDB
 *   4. 通过 SSE 报告进度
 */

import { v4 as uuidv4 } from 'uuid';
import { getDB } from '../utils/db.js';
import { broadcastTaskProgress, broadcastTaskComplete, broadcastTaskError } from '../utils/sse.js';
import { generateStoryboardSkill } from '../skills/generate-storyboard.js';

/**
 * 运行分镜生成 Agent
 * @param {string} taskId
 */
export async function runStoryboardAgent(taskId) {
  const db = getDB();

  try {
    // ── 1. 读取任务数据 ──────────────────────────────────────────────
    const task = await db.collection('tasks').findOne({ taskId });
    if (!task) throw new Error(`Task ${taskId} not found`);

    const { episodeId, projectId, payload } = task;
    const clipIds = payload?.clipIds; // 可选：只处理指定的 clips

    const [episode, project] = await Promise.all([
      db.collection('episodes').findOne({ episodeId }),
      db.collection('projects').findOne({ projectId }),
    ]);

    if (!episode) throw new Error(`Episode ${episodeId} not found`);

    // 获取需要处理的 clips
    const clipQuery = clipIds?.length
      ? { episodeId, clipId: { $in: clipIds } }
      : { episodeId };

    const clips = await db.collection('clips').find(clipQuery).sort({ clipIndex: 1 }).toArray();
    if (!clips.length) throw new Error('No clips found for storyboard generation');

    await db.collection('tasks').updateOne(
      { taskId },
      { $set: { status: 'running', progress: 5, message: `开始生成 ${clips.length} 个情节的分镜...`, updatedAt: new Date() } }
    );

    // ── 2. 为每个 clip 生成分镜 ──────────────────────────────────────
    const characters = project?.characters || [];
    const locations = project?.locations || [];
    const artStyle = project?.artStyle || 'cinematic';

    let totalPanels = 0;

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const progress = Math.round(5 + ((i + 1) / clips.length) * 85);

      broadcastTaskProgress(
        taskId,
        progress,
        `正在生成第 ${i + 1}/${clips.length} 个情节的分镜: ${clip.summary?.slice(0, 30)}...`,
        'generating_panels'
      );

      await db.collection('tasks').updateOne(
        { taskId },
        { $set: { progress, message: `生成情节 ${i + 1}/${clips.length} 的分镜`, updatedAt: new Date() } }
      );

      // 调用分镜生成 Skill
      const panels = await generateStoryboardSkill({
        clip,
        characters,
        locations,
        artStyle,
        language: project?.language || 'zh',
      });

      // ── 3. 写入面板到 MongoDB ─────────────────────────────────────
      // 删除旧面板
      await db.collection('panels').deleteMany({ clipId: clip.clipId });

      if (panels.length > 0) {
        const panelDocs = panels.map((panel, j) => ({
          panelId: `panel_${uuidv4().replace(/-/g, '').slice(0, 12)}`,
          clipId: clip.clipId,
          episodeId,
          projectId,
          panelIndex: panel.panelIndex ?? j,
          description: panel.description || '',
          characters: panel.characters || [],
          location: panel.location || clip.location,
          shotType: panel.shotType || 'medium shot',
          cameraMovement: panel.cameraMovement || 'static',
          mood: panel.mood || clip.mood || '',
          action: panel.action || '',
          dialogue: panel.dialogue || '',
          imagePrompt: panel.imagePrompt || panel.description || '',
          videoPrompt: panel.videoPrompt || '',
          imageUrl: null,
          videoUrl: null,
          status: 'draft',
          createdAt: new Date(),
          updatedAt: new Date(),
        }));

        await db.collection('panels').insertMany(panelDocs);

        // 更新 clip 的 panelIds
        await db.collection('clips').updateOne(
          { clipId: clip.clipId },
          { $set: { panelIds: panelDocs.map((p) => p.panelId), updatedAt: new Date() } }
        );

        totalPanels += panelDocs.length;
      }
    }

    // ── 4. 更新 episode 状态 ────────────────────────────────────
    await db.collection('episodes').updateOne(
      { episodeId },
      { $set: { status: 'storyboard_ready', updatedAt: new Date() } }
    );

    // ── 5. 完成任务 ────────────────────────────────────────────
    await db.collection('tasks').updateOne(
      { taskId },
      {
        $set: {
          status: 'completed',
          progress: 100,
          message: `分镜生成完成：${totalPanels} 个分镜面板`,
          result: { panelCount: totalPanels, clipCount: clips.length },
          updatedAt: new Date(),
        },
      }
    );

    broadcastTaskComplete(taskId, { panelCount: totalPanels, clipCount: clips.length });
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
