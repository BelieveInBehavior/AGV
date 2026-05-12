/**
 * Agent: 故事分析 Agent
 *
 * 无状态设计 — 只接收 taskId，从 MongoDB 读取所有数据，写回结果
 * 不持有任何内存状态，可水平扩展
 *
 * 职责:
 *   1. 读取 task → episode → project
 *   2. 调用 analyzeStorySkill (LLM)
 *   3. 将 clips/characters/locations 写入 MongoDB
 *   4. 通过 SSE 报告进度
 */

import { v4 as uuidv4 } from 'uuid';
import { getDB } from '../utils/db.js';
import { broadcastTaskProgress, broadcastTaskComplete, broadcastTaskError } from '../utils/sse.js';
import { analyzeStorySkill } from '../skills/analyze-story.js';

/**
 * 运行故事分析 Agent
 * @param {string} taskId
 */
export async function runStoryAgent(taskId) {
  const db = getDB();

  try {
    // ── 1. 读取任务数据 ──────────────────────────────────────────────
    const task = await db.collection('tasks').findOne({ taskId });
    if (!task) throw new Error(`Task ${taskId} not found`);

    const { episodeId, projectId } = task;

    const [episode, project] = await Promise.all([
      db.collection('episodes').findOne({ episodeId }),
      db.collection('projects').findOne({ projectId }),
    ]);

    if (!episode) throw new Error(`Episode ${episodeId} not found`);
    if (!project) throw new Error(`Project ${projectId} not found`);

    // ── 2. 更新状态为 running ───────────────────────────────────────
    await db.collection('tasks').updateOne(
      { taskId },
      { $set: { status: 'running', progress: 5, message: '开始分析故事...', updatedAt: new Date() } }
    );
    broadcastTaskProgress(taskId, 5, '开始分析故事文本', 'analyzing');

    // ── 3. 调用故事分析 Skill ─────────────────────────────────────
    await db.collection('episodes').updateOne(
      { episodeId },
      { $set: { status: 'analyzing', updatedAt: new Date() } }
    );

    broadcastTaskProgress(taskId, 20, '正在调用 AI 分析角色和情节...', 'llm_call');

    const { characters, locations, clips } = await analyzeStorySkill({
      text: episode.novelText,
      language: project.language || 'zh',
    });

    broadcastTaskProgress(taskId, 70, `分析完成：${characters.length} 个角色，${locations.length} 个场景，${clips.length} 个情节片段`, 'saving');

    // ── 4. 写入 MongoDB ─────────────────────────────────────────
    // 更新项目的角色和场景（合并而非覆盖）
    const existingChars = project.characters || [];
    const mergedChars = mergeByName(existingChars, characters);
    const existingLocs = project.locations || [];
    const mergedLocs = mergeByName(existingLocs, locations);

    await db.collection('projects').updateOne(
      { projectId },
      { $set: { characters: mergedChars, locations: mergedLocs, updatedAt: new Date() } }
    );

    // 创建 clips 文档
    const clipDocs = clips.map((clip, i) => ({
      clipId: `clip_${uuidv4().replace(/-/g, '').slice(0, 12)}`,
      episodeId,
      projectId,
      clipIndex: clip.clipIndex ?? i,
      content: clip.content || '',
      summary: clip.summary || '',
      characters: clip.characters || [],
      location: clip.location || '',
      mood: clip.mood || '',
      panels: [], // 由 storyboard agent 填充
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    // 先删除旧的 clips（如果是重新生成）
    await db.collection('clips').deleteMany({ episodeId });

    if (clipDocs.length > 0) {
      await db.collection('clips').insertMany(clipDocs);
    }

    // 更新 episode 状态
    await db.collection('episodes').updateOne(
      { episodeId },
      {
        $set: {
          status: 'analyzed',
          clipIds: clipDocs.map((c) => c.clipId),
          updatedAt: new Date(),
        },
      }
    );

    // ── 5. 完成任务 ──────────────────────────────────────────────
    await db.collection('tasks').updateOne(
      { taskId },
      {
        $set: {
          status: 'completed',
          progress: 100,
          message: `分析完成：${clipDocs.length} 个情节片段`,
          result: { clipCount: clipDocs.length, characterCount: mergedChars.length },
          updatedAt: new Date(),
        },
      }
    );

    broadcastTaskComplete(taskId, {
      clipCount: clipDocs.length,
      characterCount: mergedChars.length,
      locationCount: mergedLocs.length,
    });
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

/** 合并两个数组，按 name 去重（已有的优先） */
function mergeByName(existing, incoming) {
  const map = new Map(existing.map((item) => [item.name, item]));
  for (const item of incoming) {
    if (!map.has(item.name)) {
      map.set(item.name, item);
    }
  }
  return Array.from(map.values());
}
