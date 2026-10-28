import { describe, expect, test } from 'bun:test'

import { Data, Effect, Fiber, Layer, Schema } from 'effect'
import { HttpRouter, HttpServer, HttpServerRespondable, HttpServerResponse } from 'effect/http'

import { memorySink } from '../core/sinks'
import { WideEventMiddleware } from './http'
import {
  type WideEvent,
  WideEvents,
  annotate,
  currentTraceparent,
  timed,
  withWideEvent,
} from './WideEvent'

const setup = () => {
  const { events, sink } = memorySink()
  return { events, layer: WideEvents.layer({ service: 'test', sink, env: {} }) }
}

class OutOfStock extends Schema.TaggedError<OutOfStock>()('OutOfStock', {}) {
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(HttpServerResponse.jsonUnsafe({ code: 'out_of_stock' }, { status: 409 }))
  }
}
class LedgerCorrupted extends Data.TaggedError('LedgerCorrupted') {}

describe('withWideEvent', () => {
  test('maps exits to outcomes: typed failure, defect, interruption', async () => {
    const { events, layer } = setup()
    const job = <E>(self: Effect.Effect<void, E, WideEvent>) =>
      Effect.runPromiseExit(
        self.pipe(withWideEvent({ operation: 'job', kind: 'job' }), Effect.provide(layer)),
      )

    await job(annotate({ order_id: 'ord_1' }).pipe(timed('db')))
    await job(Effect.fail(new OutOfStock()))
    await job(Effect.die(new LedgerCorrupted()))
    await job(Effect.interrupt)

    expect(
      events.map(({ outcome, level, error_kind, error_type }) => ({
        outcome,
        level,
        error_kind,
        error_type,
      })),
    ).toEqual([
      { outcome: 'success', level: 'info', error_kind: undefined, error_type: undefined },
      { outcome: 'error', level: 'info', error_kind: 'expected', error_type: 'OutOfStock' },
      { outcome: 'error', level: 'error', error_kind: 'unexpected', error_type: 'LedgerCorrupted' },
      { outcome: 'error', level: 'info', error_kind: 'interrupted', error_type: 'interrupted' },
    ])
    expect(events[0]).toMatchObject({ order_id: 'ord_1', db_count: 1 })
  })

  test('continues the trace of a queue message', async () => {
    const { events, layer } = setup()
    // Flags `03`: sampled, plus a bit this version does not know yet.
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-03'
    const outgoing = await Effect.runPromise(
      currentTraceparent.pipe(
        withWideEvent({ operation: 'job', kind: 'job', traceparent }),
        Effect.provide(layer),
      ),
    )
    expect(events[0]).toMatchObject({
      trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
      parent_span_id: '00f067aa0ba902b7',
    })
    expect(outgoing).toEndWith('-01')
  })

  test('an interrupted fiber still emits its event', async () => {
    const { events, layer } = setup()
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.never.pipe(withWideEvent({ operation: 'job', kind: 'job' })),
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(layer)),
    )
    expect(events).toEqual([expect.objectContaining({ error_kind: 'interrupted' })])
  })
})

const app = () => {
  const { events, layer } = setup()
  const routes = HttpRouter.addAll([
    HttpRouter.route(
      'GET',
      '/orders/:id',
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.params
        yield* annotate({ order_id: id })
        return HttpServerResponse.jsonUnsafe({ ok: true })
      }),
    ),
    HttpRouter.route('POST', '/reserve', Effect.fail(new OutOfStock())),
    HttpRouter.route('POST', '/bug', Effect.die(new LedgerCorrupted())),
  ]).pipe(Layer.provide(WideEventMiddleware))
  const { handler, dispose } = HttpRouter.toWebHandler(
    routes.pipe(Layer.provide([layer, HttpServer.layerServices])),
    { disableLogger: true },
  )
  return { events, handler, dispose }
}

describe('WideEventMiddleware', () => {
  test('one event per request, grouped by route template', async () => {
    const { events, handler, dispose } = app()
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    await handler(new Request('http://test/orders/42?token=abc', { headers: { traceparent } }))
    await dispose()
    expect(events).toEqual([
      expect.objectContaining({
        operation: 'GET /orders/:id',
        status_code: 200,
        order_id: '42',
        trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
        parent_span_id: '00f067aa0ba902b7',
      }),
    ])
  })

  test('typed failures stay at info, defects go to error', async () => {
    const { events, handler, dispose } = app()
    expect((await handler(new Request('http://test/reserve', { method: 'POST' }))).status).toBe(409)
    expect((await handler(new Request('http://test/bug', { method: 'POST' }))).status).toBe(500)
    await dispose()
    expect(
      events.map(({ status_code, level, error_kind, error_type }) => ({
        status_code,
        level,
        error_kind,
        error_type,
      })),
    ).toEqual([
      { status_code: 409, level: 'info', error_kind: 'expected', error_type: 'OutOfStock' },
      { status_code: 500, level: 'error', error_kind: 'unexpected', error_type: 'LedgerCorrupted' },
    ])
  })
})
