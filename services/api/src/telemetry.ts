import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export type TelemetryConfig = {
  enabled: boolean;
  serviceName: string;
  otlpEndpoint?: string;
};

export const startTelemetry = (config: TelemetryConfig): NodeSDK | null => {
  if (!config.enabled) {
    return null;
  }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName
    }),
    traceExporter: config.otlpEndpoint
      ? new OTLPTraceExporter({
          url: config.otlpEndpoint
        })
      : undefined
  });

  sdk.start();
  return sdk;
};

export const getTracer = () => trace.getTracer("ccee-api");

export const endSpan = (
  span: Span | undefined,
  statusCode: number,
  attributes: Record<string, string | number | boolean | null>
): void => {
  if (!span) {
    return;
  }

  for (const [key, value] of Object.entries(attributes)) {
    if (value !== null) {
      span.setAttribute(key, value);
    }
  }

  if (statusCode >= 500) {
    span.setStatus({ code: SpanStatusCode.ERROR });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }

  span.end();
};
