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

export async function findUserByDeviceId(deviceId) {
  return getDB().collection('users').findOne({ device_id: deviceId });
}

export function userIdFromDeviceId(deviceId) {
  const safe = String(deviceId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return `user_${safe}`;
}

export async function findOrCreateUserByDeviceId(deviceId) {
  const users = getDB().collection('users');
  const existing = await findUserByDeviceId(deviceId);
  if (existing) {
    await users.updateOne(
      { device_id: deviceId },
      { $set: { last_login_time: new Date(), updated_at: new Date() } },
    );
    return existing;
  }

  const now = new Date();
  const user = {
    user_id: userIdFromDeviceId(deviceId),
    device_id: deviceId,
    phone: null,
    status: 1,
    registered_type: 'device',
    register_time: now,
    last_login_time: now,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };

  try {
    const result = await users.insertOne(user);
    return { ...user, _id: result.insertedId };
  } catch (error) {
    if (error?.code === 11000) {
      const again = await findUserByDeviceId(deviceId);
      if (again) return again;
    }
    throw error;
  }
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
