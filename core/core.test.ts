import { describe, expect, test } from 'bun:test'

import { WideEventFieldError, describeError, httpFailure, validateFields } from './contract'
import { sampled } from './sampling'
import { memorySink } from './sinks'
import { continueTrace, formatTraceparent } from './trace'
import { WideEventBuilder } from './wide-event'

describe('field contract', () => {
  test('rejects names that break queries or leak data', () => {
    expect(() => validateFields({ userId: 'u' })).toThrow(WideEventFieldError)
    expect(() => validateFields({ user_email: 'a@b.c' })).toThrow('secret, personal or raw content')
    expect(() => validateFields({ error_message: 'boom' })).toThrow(WideEventFieldError)
    expect(() => validateFields({ email_address: 'a@b.c' })).toThrow(WideEventFieldError)
    expect(validateFields({ has_email: true, email_domain: 'b.c' })).toEqual({
      has_email: true,
      email_domain: 'b.c',
    })
    expect(() => validateFields({ status_code: 200 })).toThrow('reserved')
    expect(validateFields({ status_code: 200 }, { allowReserved: true })).toEqual({
      status_code: 200,
    })
  })

  test('accepts flat primitives, skips undefined and bounds values', () => {
    expect(
      validateFields({
        user_plan: 'pro',
        cart_total_cents: 10,
        vip: true,
        coupon_code: null,
        missing: undefined,
      }),
    ).toEqual({ user_plan: 'pro', cart_total_cents: 10, vip: true, coupon_code: null })
    expect(validateFields({ note: 'x'.repeat(5000) }).note).toHaveLength(1024)
    // Bad values come from runtime data and must not fail the request.
    expect(validateFields({ ratio: Number.NaN, user: { id: 1 } } as never)).toEqual({
      ratio: null,
      user: null,
    })
  })

  test('describes errors by type and code, never by message', () => {
    class CardDeclined extends Error {}
    const described = describeError(new CardDeclined('card 4242 of jane@example.com'))
    expect(described).toEqual({ error_type: 'CardDeclined' })
    expect(describeError({ _tag: 'UnknownUser' })).toEqual({ error_type: 'UnknownUser' })
    expect(describeError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toEqual({
      error_type: 'Error',
      error_code: 'ECONNRESET',
    })
  })

  test('a 5xx is always unexpected', () => {
    expect(httpFailure(200, undefined)).toBeUndefined()
    expect(httpFailure(404, undefined)).toEqual({ error_kind: 'expected', error_type: 'http_404' })
    expect(httpFailure(503, { error_kind: 'expected', error_type: 'Busy' })).toEqual({
      error_kind: 'unexpected',
      error_type: 'Busy',
    })
  })
})

describe('trace context', () => {
  test('continues a valid traceparent and starts a new trace otherwise', () => {
    const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    const trace = continueTrace(header)
    expect(trace.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    expect(trace.parentSpanId).toBe('00f067aa0ba902b7')
    expect(formatTraceparent(trace)).toMatch(
      /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/,
    )

    for (const invalid of [
      undefined,
      null,
      'garbage',
      `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`,
    ]) {
      const fresh = continueTrace(invalid)
      expect(fresh.parentSpanId).toBeNull()
      expect(fresh.traceId).toMatch(/^[0-9a-f]{32}$/)
    }
  })
})

const start = () =>
  new WideEventBuilder(
    { service: 'test' },
    { operation: 'op', kind: 'job', trace: continueTrace(null) },
  )

describe('wide event builder', () => {
  test('emits once and ignores late writes', () => {
    const event = start()
    event.set({ user_id: 'usr_1' })
    const first = event.finish()
    event.set({ late: true })
    expect(first).toMatchObject({
      outcome: 'success',
      level: 'info',
      user_id: 'usr_1',
      service: 'test',
    })
    expect(first).not.toHaveProperty('late')
    expect(event.finish()).toBeUndefined()
  })

  test('splits duration into timings and maps failures to levels', () => {
    const event = start()
    event.addTiming('db', 4)
    event.addTiming('db', 6)
    const record = event.finish({}, { error_kind: 'unexpected', error_type: 'TypeError' })
    expect(record).toMatchObject({
      outcome: 'error',
      level: 'error',
      error_kind: 'unexpected',
      error_type: 'TypeError',
      db_count: 2,
      db_ms: 10,
      db_max_ms: 6,
    })
    expect(() => start().addTiming('duration', 1)).toThrow('reserved')
  })
})

const event = (fields: Record<string, string | number>) => ({
  trace_id: continueTrace(null).traceId,
  outcome: 'success',
  duration_ms: 10,
  ...fields,
})

describe('tail sampling', () => {
  test('keeps every unexpected error, slow and VIP event', () => {
    const { events, sink } = memorySink()
    const sample = sampled(sink, {
      rate: 0,
      slowMs: 2000,
      keep: (e) => e.user_plan === 'enterprise',
    })
    sample(event({ outcome: 'error', level: 'error' }))
    sample(event({ duration_ms: 2500 }))
    sample(event({ user_plan: 'enterprise' }))
    sample(event({ outcome: 'error', level: 'info' }))
    sample(event({}))
    expect(events).toHaveLength(3)
    expect(events.every((e) => e.sample_rate === 1)).toBe(true)
  })

  test('decides by trace ID, so every service keeps the same traces', () => {
    const { events, sink } = memorySink()
    const sample = sampled(sink, { rate: 0.5 })
    for (let i = 0; i < 200; i++) {
      const traceId = continueTrace(null).traceId
      sample({ trace_id: traceId, service: 'checkout', outcome: 'success' })
      sample({ trace_id: traceId, service: 'payments', outcome: 'success' })
    }
    const kept = (service: string) =>
      events.filter((e) => e.service === service).map((e) => e.trace_id)
    expect(kept('checkout')).toEqual(kept('payments'))
    expect(events.every((e) => e.sample_rate === 0.5)).toBe(true)
  })
})
