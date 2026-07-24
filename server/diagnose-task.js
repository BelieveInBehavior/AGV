#!/usr/bin/env node
/**
 * 诊断脚本：检查 task_6c52b5a2ac51 为什么没用引用图
 */
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config({ path: './server/.env' });

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27018';
const dbName = process.env.MONGODB_DB_NAME || 'agv';

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  const taskId = 'task_6c52b5a2ac51';

  // 1. 找任务
  const task = await db.collection('tasks').findOne({ taskId });
  console.log('\n=== TASK ===');
  console.log(JSON.stringify(task, null, 2));

  if (!task) {
    console.log('❌ Task not found');
    await client.close();
    return;
  }

  const { projectId, episodeId, type, payload } = task;

  // 2. 找项目
  const project = await db.collection('projects').findOne({ projectId });
  console.log('\n=== PROJECT (characters & locations) ===');
  console.log(`Characters: ${project?.characters?.length || 0}`);
  (project?.characters || []).slice(0, 3).forEach((c, i) => {
    console.log(`  [${i}] ${c.name}: referenceImageUrl=${!!c.referenceImageUrl ? '✓' : '✗'}, imagePrompt=${!!c.imagePrompt ? '✓' : '✗'}`);
  });
  console.log(`Locations: ${project?.locations?.length || 0}`);
  (project?.locations || []).slice(0, 3).forEach((l, i) => {
    console.log(`  [${i}] ${l.name}: referenceImageUrl=${!!l.referenceImageUrl ? '✓' : '✗'}, imagePrompt=${!!l.imagePrompt ? '✓' : '✗'}`);
  });

  // 3. 如果是 IMAGE_GENERATION，找相关的 clip/panel
  if (type === 'IMAGE_GENERATION') {
    const { clipId, panelId, beatSlot } = payload;

    if (clipId && beatSlot) {
      console.log(`\n=== BEAT FRAME (clip_id=${clipId}, slot=${beatSlot}) ===`);
      const clip = await db.collection('clips').findOne({ clipId });
      if (clip) {
        const plan = clip.storyboardPlan || {};
        const frame = plan[beatSlot] || {};
        console.log(`Frame description: ${frame.description?.slice(0, 80)}`);
        console.log(`Frame characters: ${JSON.stringify(frame.characters, null, 2)}`);
        console.log(`\nCollecting references would match:`);

        // 模拟 collect_frame_reference_urls 逻辑
        const locName = (clip.location || '').trim();
        console.log(`  Location: "${locName}"`);
        if (locName) {
          const loc = (project?.locations || []).find(l => l.name?.trim() === locName);
          console.log(`    → Found: ${loc ? '✓' : '✗'} (has ref: ${loc?.referenceImageUrl ? '✓' : '✗'})`);
        }

        console.log(`  Characters in frame:`);
        (frame.characters || []).forEach(ch => {
          if (typeof ch === 'string') {
            console.log(`    - "${ch}" (string, not object) ❌`);
          } else if (typeof ch === 'object' && ch?.name) {
            const name = ch.name?.trim();
            const projChar = (project?.characters || []).find(c => c.name?.trim() === name);
            console.log(`    - "${name}": ${projChar ? '✓ found in project' : '✗ NOT found'}, ref=${projChar?.referenceImageUrl ? '✓' : '✗'}`);
          }
        });
      } else {
        console.log('❌ Clip not found');
      }
    } else if (panelId) {
      console.log(`\n=== PANEL (panel_id=${panelId}) ===`);
      const panel = await db.collection('panels').findOne({ panelId });
      if (panel) {
        const clipId = panel.clipId;
        const clip = await db.collection('clips').findOne({ clipId });
        console.log(`Panel description: ${panel.description?.slice(0, 80)}`);
        console.log(`Panel characters: ${JSON.stringify(panel.characters, null, 2)}`);

        console.log(`\nCollecting references would match:`);
        const locName = (panel.location || clip?.location || '').trim();
        console.log(`  Location: "${locName}"`);
        if (locName) {
          const loc = (project?.locations || []).find(l => l.name?.trim() === locName);
          console.log(`    → Found: ${loc ? '✓' : '✗'} (has ref: ${loc?.referenceImageUrl ? '✓' : '✗'})`);
        }

        console.log(`  Characters:`);
        (panel.characters || []).forEach(name => {
          const projChar = (project?.characters || []).find(c => c.name?.trim() === (name || '').trim());
          console.log(`    - "${name}": ${projChar ? '✓ found' : '✗ NOT found'}, ref=${projChar?.referenceImageUrl ? '✓' : '✗'}`);
        });
      } else {
        console.log('❌ Panel not found');
      }
    } else if (episodeId) {
      console.log(`\n=== EPISODE (episode_id=${episodeId}) ===`);
      const clips = await db.collection('clips').find({ episodeId }).toArray();
      console.log(`Total clips: ${clips.length}`);
      clips.slice(0, 2).forEach(c => {
        const plan = c.storyboardPlan || {};
        console.log(`  Clip "${c.title || c.clipId}": `);
        console.log(`    Location: "${c.location}"`);
        console.log(`    Characters: ${JSON.stringify(c.characters)}`);
        console.log(`    Has beat plan: ${plan.first_frame ? '✓' : '✗'}`);
      });
    }
  }

  // 4. 检查 user_ai_settings
  if (project?.userId) {
    console.log(`\n=== USER AI SETTINGS ===`);
    const settings = await db.collection('user_ai_settings').findOne({ userId: project.userId });
    if (settings?.image) {
      const img = settings.image;
      console.log(`Provider: ${img.provider}`);
      console.log(`supportsMultiReference: ${img.supportsMultiReference}`);
      console.log(`maxReferenceImages: ${img.maxReferenceImages}`);
    } else {
      console.log('(using defaults)');
    }
  }

  await client.close();
}

main().catch(console.error);
