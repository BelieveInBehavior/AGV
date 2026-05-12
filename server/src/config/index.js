import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 与 Worker（worker/config.py）一致：根目录 .env → server/.env（后者必须 override，否则会沿用根目录里的 Mongo 等变量）
dotenv.config({ path: path.join(__dirname, '../../../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env'), override: true });

const config = {
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
    dbName: process.env.MONGODB_DB_NAME || 'agv',
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret',
    expiresIn: Number(process.env.JWT_EXPIRES_IN || 604800),
  },
  aliyunSms: {
    accessKeyId: process.env.ALIYUN_SMS_ACCESS_KEY_ID || '',
    accessKeySecret: process.env.ALIYUN_SMS_ACCESS_KEY_SECRET || '',
    signName: process.env.ALIYUN_SMS_SIGN_NAME || '',
    templateCode: process.env.ALIYUN_SMS_TEMPLATE_CODE || '',
    codeExpireSeconds: Number(process.env.SMS_CODE_EXPIRE_SECONDS || 300),
    sendCodeCooldownSeconds: Number(process.env.SEND_CODE_COOLDOWN_SECONDS || 60),
  },
  testAuth: {
    phoneNumber: process.env.TEST_PHONE_NUMBER || '15000361623',
    code: process.env.TEST_PHONE_CODE || '123456',
  },
  llm: {
    baseUrl: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'gpt-4o-mini',
  },
  fal: {
    apiKey: process.env.FAL_API_KEY || '',
    imageModel: process.env.FAL_IMAGE_MODEL || 'fal-ai/flux/schnell',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379/0',
  },
  port: Number(process.env.CWEI_PORT || 3001),
};

export default config;
