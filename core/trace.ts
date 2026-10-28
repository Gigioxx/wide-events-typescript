// W3C Trace Context (https://www.w3.org/TR/trace-context/). The `traceparent`
// header carries one trace ID across services, so every service's wide event
// for the same user action shares `trace_id`.

export type TraceContext = {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | null
  readonly flags: string
}

const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

const randomHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')

export const parseTraceparent = (
  traceparent: string | null | undefined,
): Pick<TraceContext, 'traceId' | 'spanId' | 'flags'> | undefined => {
  const [, traceId, spanId, flags] =
    traceparent?.trim().toLowerCase().match(traceparentPattern) ?? []
  // All-zero IDs are invalid by the spec.
  return traceId && spanId && flags && /[^0]/.test(traceId) && /[^0]/.test(spanId)
    ? { traceId, spanId, flags }
    : undefined
}

// A child span of the incoming `traceparent`, or a new trace when the header
// is missing or invalid.
export const continueTrace = (traceparent: string | null | undefined): TraceContext => {
  const parent = parseTraceparent(traceparent)
  return parent
    ? {
        traceId: parent.traceId,
        spanId: randomHex(8),
        parentSpanId: parent.spanId,
        flags: parent.flags,
      }
    : { traceId: randomHex(16), spanId: randomHex(8), parentSpanId: null, flags: '01' }
}

export const childTrace = (parent: TraceContext): TraceContext => ({
  traceId: parent.traceId,
  spanId: randomHex(8),
  parentSpanId: parent.spanId,
  flags: parent.flags,
})

export const formatTraceparent = (trace: Pick<TraceContext, 'traceId' | 'spanId' | 'flags'>) =>
  `00-${trace.traceId}-${trace.spanId}-${trace.flags}`
