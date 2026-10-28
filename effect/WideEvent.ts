import { Cause, Context, Effect, Exit, Layer, Option, Tracer } from 'effect'

import { type Failure, type Fields, type WideEventRecord, describeError } from '../core/contract'
import { environmentFields } from '../core/environment'
import { type Sink, emitSafely } from '../core/sinks'
import {
  type TraceContext,
  continueTrace,
  formatTraceparent,
  parseTraceparent,
} from '../core/trace'
import { WideEventBuilder } from '../core/wide-event'

// Configured once per service: environment fields and where events go.
export class WideEvents extends Context.Service<
  WideEvents,
  { readonly environment: WideEventRecord; readonly sink: Sink }
>()('wide-events/WideEvents') {
  static readonly layer = (options: {
    readonly service: string
    readonly sink: Sink
    readonly env?: Readonly<Record<string, string | undefined>>
  }) =>
    Layer.succeed(WideEvents)({
      environment: environmentFields(options.service, options.env),
      sink: options.sink,
    })
}

// The event of the current unit of work. Code that annotates requires it in
// its type, so the compiler rejects enrichment where no event exists.
export class WideEvent extends Context.Service<
  WideEvent,
  Pick<WideEventBuilder, 'trace' | 'set' | 'addTiming'>
>()('wide-events/WideEvent') {}

// An invalid field throws, which Effect turns into a defect.
export const annotate = (fields: Fields): Effect.Effect<void, never, WideEvent> =>
  WideEvent.useSync((event) => event.set(fields))

// Times an effect into `<name>_count`, `<name>_ms` and `<name>_max_ms`.
export const timed =
  (name: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | WideEvent> =>
    Effect.flatMap(Effect.service(WideEvent), (event) => {
      const startedAt = performance.now()
      return Effect.ensuring(
        self,
        Effect.sync(() => event.addTiming(name, performance.now() - startedAt)),
      )
    })

// The current event's trace as a W3C `traceparent`, for queue messages.
export const currentTraceparent: Effect.Effect<string, never, WideEvent> = WideEvent.useSync(
  (event) => formatTraceparent(event.trace),
)

// Typed failures are expected by construction. Defects are bugs.
export const failureFromCause = (cause: Cause.Cause<unknown>): Failure => {
  const defect = cause.reasons.find(Cause.isDieReason)
  if (defect) return { error_kind: 'unexpected', ...describeError(defect.defect) }
  const failure = cause.reasons.find(Cause.isFailReason)
  if (failure) return { error_kind: 'expected', ...describeError(failure.error) }
  return { error_kind: 'interrupted', error_type: 'interrupted' }
}

// Each wide event is one span: its IDs come from Effect's tracer, and
// Effect's HTTP client sends them downstream as `traceparent`.
const spanTrace = (span: Tracer.Span): TraceContext => ({
  traceId: span.traceId,
  spanId: span.spanId,
  parentSpanId: Option.match(span.parent, {
    onNone: () => null,
    onSome: (parent) => parent.spanId,
  }),
  flags: span.sampled ? '01' : '00',
})

// Span options that continue a W3C `traceparent` from a header or message.
// `undefined` nests under the current span; `null` or an invalid header starts
// a new trace, as in the plain version.
export const traceparentSpanOptions = (
  traceparent: string | null | undefined,
): Tracer.SpanOptionsNoTrace => {
  if (traceparent === undefined) return {}
  const parent = parseTraceparent(traceparent)
  return parent
    ? {
        parent: Tracer.externalSpan({
          traceId: parent.traceId,
          spanId: parent.spanId,
          // Bit 0 is `sampled`; other bits are reserved for future flags.
          sampled: (Number.parseInt(parent.flags, 16) & 1) === 1,
        }),
      }
    : { root: true }
}

export type StartOptions = {
  readonly operation: string
  readonly kind: string
  readonly fields?: Fields | undefined
}

// Starts an event on the current span. Integrations that need the final
// status, like the HTTP middleware, call it directly inside their own span.
export const startWideEvent = Effect.fnUntraced(function* (options: StartOptions) {
  const { environment, sink } = yield* WideEvents
  const span = yield* Effect.option(Effect.currentSpan)
  const trace = Option.match(span, { onNone: () => continueTrace(null), onSome: spanTrace })
  const builder = new WideEventBuilder(environment, { ...options, trace })
  // Arrow functions, so `const { set } = yield* WideEvent` keeps working.
  const event: typeof WideEvent.Service = {
    trace,
    set: (fields) => builder.set(fields),
    addTiming: (name, ms) => builder.addTiming(name, ms),
  }
  const end = (fields?: Fields, failure?: Failure) =>
    Effect.sync(() => {
      const record = builder.finish(fields, failure)
      if (record) emitSafely(sink, record)
    })
  return { event, end }
})

// One event around any effect: a queue job, a cron run, a script. A
// `traceparent` continues a trace from a message, `null` starts a new one,
// and omitting it nests the event under the current span.
export const withWideEvent =
  (options: StartOptions & { readonly traceparent?: string | null | undefined }) =>
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, WideEvent> | WideEvents> =>
    Effect.gen(function* () {
      const { event, end } = yield* startWideEvent(options)
      return yield* self.pipe(
        Effect.provideService(WideEvent, event),
        Effect.onExit((exit) =>
          end({}, Exit.isFailure(exit) ? failureFromCause(exit.cause) : undefined),
        ),
      )
    }).pipe(Effect.withSpan(options.operation, traceparentSpanOptions(options.traceparent)))
