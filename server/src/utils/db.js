import { MongoClient } from 'mongodb';
import config from '../config/index.js';

let client = null;
let db = null;

export async function connectDB() {
  if (db) return db;

  client = new MongoClient(config.mongodb.uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  db = client.db(config.mongodb.dbName);

  const users = db.collection('users');
  await users.createIndex({ phone: 1 }, { unique: true, sparse: true });
  await users.createIndex({ user_id: 1 }, { unique: true });

  // Video generation collections
  const projects = db.collection('projects');
  await projects.createIndex({ projectId: 1 }, { unique: true });
  await projects.createIndex({ userId: 1 });

  const episodes = db.collection('episodes');
  await episodes.createIndex({ episodeId: 1 }, { unique: true });
  await episodes.createIndex({ projectId: 1 });

  const clips = db.collection('clips');
  await clips.createIndex({ clipId: 1 }, { unique: true });
  await clips.createIndex({ episodeId: 1 });

  const panels = db.collection('panels');
  await panels.createIndex({ panelId: 1 }, { unique: true });
  await panels.createIndex({ clipId: 1 });
  await panels.createIndex({ episodeId: 1 });

  const tasks = db.collection('tasks');
  await tasks.createIndex({ taskId: 1 }, { unique: true });
  await tasks.createIndex({ status: 1 });
  await tasks.createIndex({ projectId: 1 });

  const userAiSettings = db.collection('user_ai_settings');
  await userAiSettings.createIndex({ userId: 1 }, { unique: true });

  return db;
}

export function getDB() {
  if (!db) throw new Error('MongoDB not connected');
  return db;
}
