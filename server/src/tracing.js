/**
 * OpenTelemetry（可选）：设置 OTEL_EXPORTER_OTLP_ENDPOINT 或 OTEL_EXPORTER_OTLP_TRACES_ENDPOINT 后导出 Trace。
 * 须在其它 import 之前由 app.js 加载。
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';

function tracesUrl() {
  const explicit = (process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || '').trim();
  if (explicit) return explicit;
  const base = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '').trim().replace(/\/$/, '');
  if (!base) return '';
  return base.includes('/v1/traces') ? base : `${base}/v1/traces`;
}

const url = tracesUrl();
if (url) {
  const sdk = new NodeSDK({
    resource: new Resource({
      'service.name': process.env.OTEL_SERVICE_NAME || 'agv-api',
    }),
    traceExporter: new OTLPTraceExporter({ url }),
  });
  sdk.start();
  const shutdown = () => {
    sdk
      .shutdown()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
