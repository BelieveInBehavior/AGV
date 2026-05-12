import { useEffect, useRef, useState } from 'react';
import { sendCode, setToken, setUserInfo, verifyCode } from '../../services/auth';

const TEST_PHONE = '15000361623';
const TEST_CODE = '123456';

export default function LoginPage() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const phoneValid = /^1\d{10}$/.test(phone);
  const isTestPhone = phone === TEST_PHONE;

  const onSendCode = async () => {
    if (!phoneValid || countdown > 0 || isTestPhone) return;
    setError('');
    const result = await sendCode(phone);
    if (!result.success) {
      setError(result.message);
      return;
    }

    setCountdown(60);
    timerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const onLogin = async () => {
    if (!phoneValid || code.length < 4 || loading) return;
    setError('');
    setLoading(true);
    try {
      const result = await verifyCode(phone, code);
      if (!result.success || !result.token) {
        setError(result.message || '登录失败');
        setLoading(false);
        return;
      }
      setToken(result.token);
      if (result.user_info) setUserInfo(result.user_info);
      window.location.href = '/';
    } catch {
      setError('网络异常，请稍后重试');
      setLoading(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-card">
        <h1>手机号登录</h1>
        <p>输入手机号与验证码，完成登录</p>

        <label className="field">
          <span>手机号</span>
          <input
            value={phone}
            type="tel"
            placeholder="请输入 11 位手机号"
            maxLength={11}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
          />
        </label>
        {isTestPhone ? <div className="hint">测试账号无需获取验证码，直接输入 {TEST_CODE} 登录。</div> : null}

        <div className="field code-row">
          <label>
            <span>验证码</span>
            <input
              value={code}
              type="text"
              placeholder="请输入验证码"
              maxLength={6}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </label>
          <button onClick={onSendCode} disabled={!phoneValid || countdown > 0 || isTestPhone}>
            {isTestPhone ? '无需获取' : countdown > 0 ? `${countdown}s` : '获取验证码'}
          </button>
        </div>

        {error ? <div className="error">{error}</div> : null}

        <button className="login-btn" onClick={onLogin} disabled={!phoneValid || code.length < 4 || loading}>
          {loading ? '登录中...' : '登录'}
        </button>
      </section>
    </main>
  );
}
