# Plain TypeScript version

The current event travels with the async call through `AsyncLocalStorage`, so any function in the call stack can enrich it without passing it around. It runs on Bun, Node and Deno.

Copy `core/` and this folder. Only the Hono middleware depends on Hono.

## Set up once

```ts
import { stdoutSink } from '../core/sinks'
import { createWideEvents } from './wide-events'

export const wideEvents = createWideEvents({ service: 'checkout', sink: stdoutSink })
```

Create it at startup and share it, like a logger.

## HTTP requests

```ts
import { Hono } from 'hono'

import { errorResponse, wideEventMiddleware } from './hono'

const app = new Hono()
app.use(wideEventMiddleware(wideEvents))
app.onError(errorResponse)
```

The middleware:

- continues the incoming `traceparent`
- times the request and records the route template and status
- classifies the outcome
- emits one event, even when the handler throws

[`hono.ts`](hono.ts) is about 50 lines. To port it to Express or Fastify, keep its steps: `start`, run the handler inside `event.run`, then `end` with the status.

## Enrich from anywhere

```ts
import { annotate, timed, traceHeaders } from './wide-events'

const user = await timed('db', () => findUser(id)) // db_count, db_ms, db_max_ms
annotate({ user_id: user.id, user_plan: user.plan })

await fetch(url, { headers: { ...traceHeaders() } }) // the next service joins the trace
```

`annotate` outside an event does nothing, so shared code also runs in scripts and tests.

## Jobs, crons, scripts

```ts
await wideEvents.run(
  { operation: 'send_receipt', kind: 'job', traceparent: message.traceparent },
  async () => {
    annotate({ order_id: message.order_id, queue_age_ms: Date.now() - message.enqueued_at })
    await timed('external', () => sendEmail(message))
  },
)
```

Put `currentTraceparent()` in the queue message when you enqueue. The job's event then shares the request's `trace_id`. A `run` inside another event becomes its child on the same trace.

## Expected and unexpected failures

```ts
class CardDeclined extends ExpectedError {
  constructor() {
    super('card_declined', 402)
  }
}
```

Throw an `ExpectedError` subclass for failures the product handles on purpose. The event gets `outcome: error`, `error_kind: expected` and `error_code: card_declined`, at level `info`. `errorResponse` turns it into a `402` with `{ "code": "card_declined" }`.

Anything else that is thrown is `unexpected` at level `error`, even an upstream error that carries a 4xx `status`. So is every 5xx. In the Hono middleware, an `HTTPException` with a 4xx status counts as expected.

## Sampling

```ts
import { sampled } from '../core/sampling'

createWideEvents({
  service: 'checkout',
  sink: sampled(stdoutSink, {
    rate: 0.05,
    slowMs: 2000,
    keep: (event) => event.user_plan === 'enterprise',
  }),
})
```

## Example

[`example/`](example) holds checkout, payments and a receipt worker. `bun run plain` runs them together.
