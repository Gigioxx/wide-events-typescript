import { describe, expect, test } from 'bun:test'

import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { memorySink } from '../core/sinks'
import { sleep } from '../fixtures/store'
import { ExpectedError } from './errors'
import { errorResponse, wideEventMiddleware } from './hono'
import { annotate, createWideEvents, timed, traceHeaders } from './wide-events'

const setup = () => {
  const { events, sink } = memorySink()
  return { events, wideEvents: createWideEvents({ service: 'test', sink, env: {} }) }
}

describe('run', () => {
  test('emits one event on success and on throw', async () => {
    const { events, wideEvents } = setup()
    await wideEvents.run({ operation: 'ok', kind: 'job' }, async () =>
      annotate({ order_id: 'ord_1' }),
    )
    const failing = wideEvents.run({ operation: 'boom', kind: 'job' }, async () => {
      throw new TypeError('secret detail')
    })
    expect(failing).rejects.toThrow(TypeError)
    await failing.catch(() => undefined)

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ operation: 'ok', outcome: 'success', order_id: 'ord_1' })
    expect(events[1]).toMatchObject({ operation: 'boom', level: 'error', error_type: 'TypeError' })
    expect(JSON.stringify(events[1])).not.toContain('secret detail')
  })

  test('keeps concurrent events apart', async () => {
    const { events, wideEvents } = setup()
    const job = (userId: string, delay: number) =>
      wideEvents.run({ operation: 'job', kind: 'job' }, async () => {
        annotate({ user_id: userId })
        await sleep(delay)
        await timed('db', () => sleep(1))
        annotate({ finished_by: userId })
      })
    await Promise.all([job('usr_a', 10), job('usr_b', 0)])
    for (const event of events) expect(event.user_id).toBe(event.finished_by)
    expect(events.map((event) => event.db_count)).toEqual([1, 1])
  })

  test('nested events join the parent trace', async () => {
    const { events, wideEvents } = setup()
    await wideEvents.run({ operation: 'parent', kind: 'job' }, async (parent) => {
      expect(traceHeaders().traceparent).toBe(parent.traceparent)
      await wideEvents.run({ operation: 'child', kind: 'job' }, async () => undefined)
    })
    const [child, parent] = events
    expect(child?.trace_id).toBe(parent?.trace_id)
    expect(child?.parent_span_id).toBe(parent?.span_id)
  })

  test('annotate outside an event does nothing', () => {
    expect(() => annotate({ user_id: 'usr_1' })).not.toThrow()
  })
})

describe('hono middleware', () => {
  class CardDeclined extends ExpectedError {
    constructor() {
      super('card_declined', 402)
    }
  }

  const app = () => {
    const { events, wideEvents } = setup()
    const hono = new Hono()
    hono.use(wideEventMiddleware(wideEvents))
    hono.onError(errorResponse)
    hono.get('/orders/:id', (c) => {
      annotate({ order_id: c.req.param('id') })
      return c.json({ ok: true })
    })
    hono.post('/declined', () => {
      throw new CardDeclined()
    })
    hono.post('/bug', () => {
      throw new Error('undefined is not a function')
    })
    hono.get('/missing', () => {
      throw new HTTPException(404)
    })
    hono.get('/bad-field', () => {
      annotate({ userEmail: 'jane@example.com' })
      return new Response('unreachable')
    })
    return { events, hono }
  }

  test('one event per request, grouped by route template', async () => {
    const { events, hono } = app()
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    await hono.request('/orders/42?token=abc', { headers: { traceparent } })
    expect(events).toEqual([
      expect.objectContaining({
        operation: 'GET /orders/:id',
        http_route: '/orders/:id',
        status_code: 200,
        outcome: 'success',
        order_id: '42',
        trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
        parent_span_id: '00f067aa0ba902b7',
      }),
    ])
  })

  test('expected failures stay at info, bugs go to error', async () => {
    const { events, hono } = app()
    expect((await hono.request('/declined', { method: 'POST' })).status).toBe(402)
    expect((await hono.request('/bug', { method: 'POST' })).status).toBe(500)
    expect((await hono.request('/missing')).status).toBe(404)
    expect(
      events.map(({ level, error_kind, error_type, error_code }) => ({
        level,
        error_kind,
        error_type,
        error_code,
      })),
    ).toEqual([
      {
        level: 'info',
        error_kind: 'expected',
        error_type: 'CardDeclined',
        error_code: 'card_declined',
      },
      { level: 'error', error_kind: 'unexpected', error_type: 'Error', error_code: undefined },
      { level: 'info', error_kind: 'expected', error_type: 'HTTPException', error_code: undefined },
    ])
  })

  test('an invalid field fails loudly', async () => {
    const { events, hono } = app()
    expect((await hono.request('/bad-field')).status).toBe(500)
    expect(events[0]).toMatchObject({ error_type: 'WideEventFieldError', level: 'error' })
  })
})
