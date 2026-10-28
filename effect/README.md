# Effect version

The same events as the plain version, built for [Effect](https://effect.website) 4. Two Effect features do work that plain TypeScript leaves to convention:

- **The current event is a service.** Code that calls `annotate` needs `WideEvent` in its type. If you enrich where no event exists, it does not compile.
- **The error channel already classifies failures.** Typed failures are expected and defects are unexpected. You do not need an `ExpectedError` base class.

Copy `core/` and this folder. Built and tested with Effect 4.0.7. `effect/http` is marked unstable, so check the changelog when you upgrade.

## Set up once

```ts
import { stdoutSink } from '../core/sinks'
import { WideEvents } from './WideEvent'

const WideEventsLive = WideEvents.layer({ service: 'checkout', sink: stdoutSink })
```

## HTTP requests

```ts
import { HttpRouter, HttpServer } from 'effect/http'

import { WideEventMiddleware } from './http'

const Routes = HttpRouter.add('POST', '/checkout', checkout).pipe(
  Layer.provide(WideEventMiddleware),
)

const { handler } = HttpRouter.toWebHandler(
  Routes.pipe(Layer.provide([WideEventsLive, HttpServer.layerServices])),
  { disableLogger: true },
)
```

`disableLogger` turns off Effect's access log line, which the wide event replaces.

The middleware:

- opens a span for the request, continuing the incoming `traceparent`
- provides `WideEvent` to the handler
- records the route template and the status the server sends, including for failures
- emits one event

Route middleware runs only for matched routes. A request that matches no route gets Effect's 404 and no event. The Hono version emits one.

## Enrich

```ts
import { annotate, timed } from './WideEvent'

const checkout = Effect.gen(function* () {
  const user = yield* findUser(id).pipe(timed('db'))
  yield* annotate({ user_id: user.id, user_plan: user.plan })
  const response = yield* client.execute(request).pipe(timed('external'))
})
```

Effect's HTTP client sends `traceparent` on its own, so payments joins the same trace. Each client call opens its own span. Payments' `parent_span_id` therefore points at that client span, not at the checkout event. Join services on `trace_id`.

## Jobs, crons, scripts

```ts
const sendReceipt = (message: ReceiptMessage) =>
  Effect.gen(function* () {
    yield* annotate({ order_id: message.order_id })
    yield* sendEmail(message).pipe(timed('external'))
  }).pipe(
    withWideEvent({ operation: 'send_receipt', kind: 'job', traceparent: message.traceparent }),
  )
```

Put `yield* currentTraceparent` in the queue message when you enqueue. Without a `traceparent`, `withWideEvent` nests under the current span. With `null`, it starts a new trace.

## Expected and unexpected failures

| Exit                                    | Event                                   |
| --------------------------------------- | --------------------------------------- |
| Success                                 | `outcome: success`                      |
| Typed failure (`Effect.fail`)           | `error_kind: expected`, level `info`    |
| Defect (`Effect.die`, `orDie`, a throw) | `error_kind: unexpected`, level `error` |
| Interruption                            | `error_kind: interrupted`, level `info` |
| Any 5xx response                        | `error_kind: unexpected`, level `error` |

`error_type` is the error's `_tag`. Give typed errors their HTTP status with `HttpServerRespondable`:

```ts
class CardDeclined extends Schema.TaggedError<CardDeclined>()('CardDeclined', {}) {
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(HttpServerResponse.jsonUnsafe({ code: 'card_declined' }, { status: 402 }))
  }
}
```

When a failure is your bug, use `Effect.die` or `Effect.orDie`, for example when another service rejects a request you built. The event then says `unexpected` instead of blaming the caller.

Infrastructure errors like `SqlError` or `HttpClientError` are typed failures too. In an HTTP route, one that escapes becomes a 5xx and is logged as `unexpected`. In a job nothing upgrades it, so use `Effect.orDie` on errors the job cannot handle.

## Tracing

Every wide event is one span: `trace_id` and `span_id` come from Effect's tracer. If you install an OpenTelemetry exporter, your traces and your wide events share IDs. Without one, the middleware reads `traceparent` itself, so the IDs still line up across services.

## Example

[`example/`](example) holds checkout, payments and a receipt worker. `bun run effect` runs them together.
