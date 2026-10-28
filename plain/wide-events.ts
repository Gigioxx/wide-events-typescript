import { AsyncLocalStorage } from 'node:async_hooks'

import type { Failure, Fields } from '../core/contract'
import { environmentFields } from '../core/environment'
import { type Sink, emitSafely } from '../core/sinks'
import { type TraceContext, childTrace, continueTrace, formatTraceparent } from '../core/trace'
import { WideEventBuilder } from '../core/wide-event'
import { classifyError } from './errors'

// The current event follows async calls, so any function deep in the stack
// can enrich it without passing it around.
const storage = new AsyncLocalStorage<WideEvent>()

export type StartOptions = {
  readonly operation: string
  readonly kind: string
  // Continues the trace of an incoming header or queue message. When omitted,
  // the event becomes a child of the current event, or starts a new trace.
  readonly traceparent?: string | null | undefined
  readonly fields?: Fields | undefined
}

export class WideEvent {
  readonly #builder: WideEventBuilder
  readonly #sink: Sink

  constructor(builder: WideEventBuilder, sink: Sink) {
    this.#builder = builder
    this.#sink = sink
  }

  get trace(): TraceContext {
    return this.#builder.trace
  }

  get traceparent(): string {
    return formatTraceparent(this.#builder.trace)
  }

  set(fields: Fields): void {
    this.#builder.set(fields)
  }

  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = performance.now()
    try {
      return await fn()
    } finally {
      this.#builder.addTiming(name, performance.now() - startedAt)
    }
  }

  // Runs `fn` with this as the current event for `annotate` and `timed`.
  run<T>(fn: () => T): T {
    return storage.run(this, fn)
  }

  // Emits the event. Only the first call emits.
  end(fields?: Fields, failure?: Failure): void {
    const event = this.#builder.finish(fields, failure)
    if (event) emitSafely(this.#sink, event)
  }
}

export type WideEventsOptions = {
  readonly service: string
  readonly sink: Sink
  readonly env?: Readonly<Record<string, string | undefined>>
}

// Create once at startup and share it, like a logger.
export const createWideEvents = (options: WideEventsOptions) => {
  const environment = environmentFields(options.service, options.env)

  const start = ({ operation, kind, traceparent, fields }: StartOptions): WideEvent => {
    const parent = storage.getStore()
    const trace =
      traceparent !== undefined || parent === undefined
        ? continueTrace(traceparent)
        : childTrace(parent.trace)
    return new WideEvent(
      new WideEventBuilder(environment, { operation, kind, trace, fields }),
      options.sink,
    )
  }

  // One event around any unit of work: a queue job, a cron run, a script.
  const run = async <T>(
    startOptions: StartOptions,
    fn: (event: WideEvent) => Promise<T>,
  ): Promise<T> => {
    const event = start(startOptions)
    try {
      const result = await event.run(() => fn(event))
      event.end()
      return result
    } catch (error) {
      event.end({}, classifyError(error))
      throw error
    }
  }

  return { start, run }
}

export type WideEvents = ReturnType<typeof createWideEvents>

// Adds business context to the current event from anywhere. Outside an event
// it does nothing, so shared code also runs in scripts and tests.
export const annotate = (fields: Fields): void => {
  storage.getStore()?.set(fields)
}

// Times `fn` into `<name>_count`, `<name>_ms` and `<name>_max_ms`.
export const timed = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
  storage.getStore()?.time(name, fn) ?? fn()

// The current trace as a W3C `traceparent`, for queue messages.
export const currentTraceparent = (): string | undefined => storage.getStore()?.traceparent

// Headers for an outgoing call, so the next service continues this trace.
export const traceHeaders = (): Record<string, string> => {
  const traceparent = currentTraceparent()
  return traceparent ? { traceparent } : {}
}
