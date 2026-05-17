/**
 * 情节流水线：结构化日志 + OpenTelemetry Span（API 侧）
 */
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('agv.pipeline', '1.0.0');

function ts() {
  return new Date().toISOString();
}

/** 单行 JSON，便于日志采集（Datadog / Loki 等） */
export function logPipelineEvent(payload) {
  const line = JSON.stringify({ ts: ts(), component: 'agv.pipeline', ...payload });
  console.log(line);
}

/**
 * @param {string} name
 * @param {Record<string, string | number | boolean>} attrs
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withPipelineSpan(name, attrs, fn) {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      Object.entries(attrs).forEach(([k, v]) => {
        if (v !== undefined && v !== null) span.setAttribute(k, v);
      });
      return await fn();
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(e?.message || e) });
      throw e;
    } finally {
      span.end();
    }
  });
}

/** 情节分析任务入队瞬间（短 span，便于与 Worker 侧串联） */
export function emitStoryAnalysisEnqueuedSpan(attrs) {
  const span = tracer.startSpan('pipeline.story_analysis.enqueued');
  try {
    Object.entries(attrs).forEach(([k, v]) => {
      if (v !== undefined && v !== null) span.setAttribute(k, String(v));
    });
  } finally {
    span.end();
  }
}
