/**
 * JSON 解析工具 — 安全处理 LLM 输出的 JSON
 */

/**
 * 从 LLM 输出文本中提取 JSON
 * LLM 可能在 JSON 前后添加 markdown 代码块或说明文字
 * @param {string} text
 * @returns {any}
 */
export function safeParseJson(text) {
  if (!text) throw new Error('Empty response from LLM');

  // 尝试直接解析
  try {
    return JSON.parse(text.trim());
  } catch {}

  // 提取 ```json ... ``` 代码块
  const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1].trim());
    } catch {}
  }

  // 提取第一个 { 到最后一个 } 之间的内容
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {}
  }

  // 提取第一个 [ 到最后一个 ] 之间的内容
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    try {
      return JSON.parse(text.slice(firstBracket, lastBracket + 1));
    } catch {}
  }

  throw new Error(`Failed to parse JSON from LLM response: ${text.slice(0, 200)}`);
}

/**
 * 安全获取嵌套对象属性
 * @param {object} obj
 * @param {string} path - 点分隔路径, 如 'a.b.c'
 * @param {any} defaultValue
 */
export function safeGet(obj, path, defaultValue = null) {
  try {
    return path.split('.').reduce((o, k) => o?.[k], obj) ?? defaultValue;
  } catch {
    return defaultValue;
  }
}
