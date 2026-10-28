import { type Logger, ROOT_CONTEXT, SeverityNumber, TraceFlags, trace } from '@opentelemetry/api'

import type { Sink } from '../core/sinks'

// Sends each wide event as one OpenTelemetry log record. Every field becomes
// an attribute, so queries written for the JSON lines keep working.
export const otlpSink =
  (logger: Logger): Sink =>
  (event) => {
    const error = event.level === 'error'
    const { trace_id: traceId, span_id: spanId } = event
    logger.emit({
      ...(typeof event.timestamp === 'string' && { timestamp: new Date(event.timestamp) }),
      severityNumber: error ? SeverityNumber.ERROR : SeverityNumber.INFO,
      severityText: error ? 'ERROR' : 'INFO',
      body: event.operation,
      attributes: event,
      // The record's own trace fields let backends link it to the trace. It
      // is marked sampled because the event was kept: trace-based log filters
      // drop unsampled records.
      ...(typeof traceId === 'string' &&
        typeof spanId === 'string' && {
          context: trace.setSpanContext(ROOT_CONTEXT, {
            traceId,
            spanId,
            traceFlags: TraceFlags.SAMPLED,
          }),
        }),
    })
  }
