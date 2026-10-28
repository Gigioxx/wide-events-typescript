import {
  type Failure,
  type FieldValue,
  type Fields,
  WideEventFieldError,
  type WideEventRecord,
  levelFor,
  reservedFields,
  validateFields,
} from './contract'
import type { TraceContext } from './trace'

export type WideEventStart = {
  // Stable name of the unit of work: `POST /checkout`, `send_receipt`.
  readonly operation: string
  // What started it: `http`, `job`, `cron`, `script`.
  readonly kind: string
  readonly trace: TraceContext
  // Fields from the integration that starts the event, such as `http_method`.
  // Reserved names are allowed here.
  readonly fields?: Fields | undefined
}

type Timing = { count: number; ms: number; maxMs: number }

const timingName = /^[a-z][a-z0-9_]{0,40}$/
const round = (ms: number) => Math.round(ms * 10) / 10

// One unit of work, accumulated while it runs and emitted once at the end.
// The plain and Effect lifecycles both wrap it: they decide where the event
// lives and when it ends; this class decides what it contains.
export class WideEventBuilder {
  readonly trace: TraceContext
  readonly #environment: WideEventRecord
  readonly #start: WideEventStart
  readonly #timestamp = new Date().toISOString()
  readonly #startedAt = performance.now()
  readonly #fields: Record<string, FieldValue>
  readonly #timings = new Map<string, Timing>()
  #ended = false

  constructor(environment: WideEventRecord, start: WideEventStart) {
    this.trace = start.trace
    this.#environment = environment
    this.#start = start
    this.#fields = validateFields(start.fields ?? {}, { allowReserved: true })
  }

  // Business context. Late writes after the event was emitted are ignored.
  set(fields: Fields): void {
    if (this.#ended) return
    Object.assign(this.#fields, validateFields(fields))
  }

  // Feeds `<name>_count`, `<name>_ms` and `<name>_max_ms`, which split
  // `duration_ms` into time spent waiting on others. Concurrent calls overlap,
  // so the sum can exceed `duration_ms`.
  addTiming(name: string, ms: number): void {
    if (this.#ended) return
    if (!timingName.test(name))
      throw new WideEventFieldError(name, 'timing name must be snake_case')
    if (reservedFields.has(`${name}_ms`))
      throw new WideEventFieldError(name, 'timing name is reserved')
    const timing = this.#timings.get(name) ?? { count: 0, ms: 0, maxMs: 0 }
    timing.count += 1
    timing.ms += ms
    timing.maxMs = Math.max(timing.maxMs, ms)
    this.#timings.set(name, timing)
  }

  // Returns the final event exactly once. Every later call returns undefined,
  // so racing success, error and timeout paths cannot emit twice.
  finish(fields: Fields = {}, failure?: Failure): WideEventRecord | undefined {
    if (this.#ended) return undefined
    const final = validateFields(fields, { allowReserved: true })
    this.#ended = true

    const timings: Record<string, number> = {}
    for (const [name, timing] of this.#timings) {
      timings[`${name}_count`] = timing.count
      timings[`${name}_ms`] = round(timing.ms)
      timings[`${name}_max_ms`] = round(timing.maxMs)
    }

    return {
      timestamp: this.#timestamp,
      level: levelFor(failure?.error_kind),
      operation: this.#start.operation,
      kind: this.#start.kind,
      outcome: failure ? 'error' : 'success',
      ...(failure && { error_kind: failure.error_kind, error_type: failure.error_type }),
      ...(failure?.error_code !== undefined && { error_code: failure.error_code }),
      duration_ms: round(performance.now() - this.#startedAt),
      ...this.#fields,
      ...final,
      ...timings,
      trace_id: this.trace.traceId,
      span_id: this.trace.spanId,
      parent_span_id: this.trace.parentSpanId,
      ...this.#environment,
    }
  }
}
