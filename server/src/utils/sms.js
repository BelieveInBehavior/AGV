import config from '../config/index.js';

let client = null;

async function getClient() {
  if (client) return client;

  const { accessKeyId, accessKeySecret } = config.aliyunSms;
  if (!accessKeyId || !accessKeySecret) {
    console.warn('[SMS] 阿里云短信未配置，验证码将仅打印到控制台');
    return null;
  }

  const dypns = await import('@alicloud/dypnsapi20170525');
  const teaUtil = await import('@alicloud/tea-util');

  const Dypnsapi20170525 = dypns.default ?? dypns;
  const SendSmsVerifyCodeRequest = dypns.SendSmsVerifyCodeRequest;
  const RuntimeOptions = teaUtil.RuntimeOptions ?? teaUtil.default?.RuntimeOptions;

  const apiConfig = {
    accessKeyId,
    accessKeySecret,
    endpoint: 'dypnsapi.aliyuncs.com',
  };

  const ClientClass = Dypnsapi20170525?.default ?? Dypnsapi20170525;
  client = new ClientClass(apiConfig);
  client._SendSmsVerifyCodeRequest = SendSmsVerifyCodeRequest;
  client._RuntimeOptions = RuntimeOptions;
  return client;
}

export async function sendSmsCode(phoneNumber, code) {
  const smsClient = await getClient();

  if (!smsClient) {
    console.log(`[SMS-DEV] 验证码 -> ${phoneNumber}: ${code}`);
    return { success: true, message: '验证码已发送(开发模式)', requestId: 'dev' };
  }

  const SendSmsVerifyCodeRequest = smsClient._SendSmsVerifyCodeRequest;
  const RuntimeOptions = smsClient._RuntimeOptions;
  const { signName, templateCode } = config.aliyunSms;
  const codeForSms = code != null ? String(code) : '';

  const request = new SendSmsVerifyCodeRequest({
    signName: signName || '速通互联验证码',
    templateCode: templateCode || '100001',
    phoneNumber,
    templateParam: JSON.stringify({ code: codeForSms, min: '5' }),
  });

  const runtime = new RuntimeOptions({});

  try {
    const response = await smsClient.sendSmsVerifyCodeWithOptions(request, runtime);
    const body = response.body || {};
    if (body.code === 'OK') {
      return {
        success: true,
        message: '验证码已发送',
        requestId: body.requestId || body.request_id,
      };
    }

    return {
      success: false,
      message: body.message || '短信发送失败',
      requestId: body.requestId || body.request_id,
    };
  } catch (error) {
    console.error('[SMS] 发送失败:', error.message);
    if (error.data && error.data.Recommend) {
      console.error('[SMS] 诊断:', error.data.Recommend);
    }
    return { success: false, message: '短信服务异常，请稍后重试' };
  }
}
