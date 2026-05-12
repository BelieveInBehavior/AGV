import { getDB } from './db.js';

function generateUserId() {
  return `user_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export async function findUserByPhone(phone) {
  return getDB().collection('users').findOne({ phone });
}

export async function findUserById(userId) {
  return getDB().collection('users').findOne({ user_id: userId });
}

export async function createUser(phone) {
  const users = getDB().collection('users');
  const now = new Date();
  const user = {
    user_id: generateUserId(),
    phone,
    status: 1,
    registered_type: 'phone',
    register_time: now,
    last_login_time: now,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  const result = await users.insertOne(user);
  return { ...user, _id: result.insertedId };
}

export async function updateUser(userId, updates) {
  const users = getDB().collection('users');
  const result = await users.findOneAndUpdate(
    { user_id: userId },
    { $set: { ...updates, updated_at: new Date() } },
    { returnDocument: 'after' },
  );
  return result;
}
