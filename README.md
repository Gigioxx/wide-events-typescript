# Wide events in TypeScript

Emit one context-rich event per request, per service. This repo is a working reference with two versions, plain TypeScript and [Effect](https://effect.website). It includes tests and a demo that finds a bug from the events alone.

The ideas come from Boris Tane's [Logging Sucks](https://loggingsucks.com) and his [`logging-best-practices`](https://github.com/boristane/agent-skills) agent skill. See [Credits](#credits).

## Try it

```sh
bun install
bun run plain   # or: bun run effect
bun run demo    # simulate 23k events, then investigate them with DuckDB
```

`bun run plain` starts three services (checkout, payments, receipts). It sends one request per outcome and prints every event as one JSON line. Add `| jq` to read them.

## The idea

Instead of a diary of log lines:

```ts
app.post('/checkout', async (c) => {
  console.log('checkout started')
  const user = await findUser(body.user_id)
  console.log(`user ${user.id} loaded`)
  const charge = await pay(total)
  console.log('payment ok', charge.id)
  return c.json({ order_id })
})
```

State facts about the request as you learn them:

```ts
app.use(wideEventMiddleware(wideEvents))

app.post('/checkout', async (c) => {
  const user = await timed('db', () => findUser(body.user_id))
  annotate({ user_id: user.id, user_plan: user.plan, flag_new_checkout: newCheckout })

  const charge = await timed('external', () => pay(total))
  annotate({ cart_total_cents: total, coupon_code: body.coupon, charge_id: charge.id })

  return c.json({ order_id })
})
```

The middleware emits one line when the request ends:

```json
{
  "timestamp": "2026-10-28T13:45:04.103Z",
  "level": "error",
  "operation": "POST /checkout",
  "outcome": "error",
  "error_kind": "unexpected",
  "error_type": "PaymentFailed",
  "duration_ms": 2.3,
  "user_id": "usr_217",
  "user_plan": "pro",
  "flag_new_checkout": true,
  "cart_subtotal_cents": 12596,
  "cart_total_cents": 11336.4,
  "coupon_code": "WELCOME10",
  "payment_error_code": "invalid_amount",
  "status_code": 500,
  "db_ms": 2.2,
  "external_ms": 0,
  "trace_id": "002ee7112055040f56484c3792b7e238",
  "service": "checkout",
  "service_version": "1.5.0",
  "commit_hash": "e4f5a6b",
  "region": "iad1"
}
```

Debugging turns into `group by`: which release, which plan, which flag, which coupon. That covers questions nobody thought to ask while writing the code. The [demo](demo/README.md) goes from "something is wrong" to this root cause in five queries.

## What is in here

| Folder                  | Contents                                                                                          | Copy it when                       |
| ----------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------- |
| [`core/`](core)         | Field contract, trace context, environment, event builder, tail sampling, sinks. No dependencies. | Always. Both versions build on it. |
| [`plain/`](plain)       | `AsyncLocalStorage` lifecycle, Hono middleware, example services.                                 | Your code is plain TypeScript.     |
| [`effect/`](effect)     | Effect 4 services, `withWideEvent`, `HttpRouter` middleware, example services.                    | Your code uses Effect.             |
| [`otlp/`](otlp)         | A sink that exports events as OpenTelemetry log records over OTLP.                                | Your backend speaks OTLP.          |
| [`demo/`](demo)         | Traffic simulator and a step-by-step DuckDB investigation.                                        | You want to see why it matters.    |
| [`fixtures/`](fixtures) | A fake store shared by the examples. It knows nothing about wide events.                          | Never.                             |

This is not an npm package. Copy `core/` (about 400 lines) and one of `plain/` or `effect/` (about 200 lines) into your project and make them yours.

## Rules

Each rule is built into the code here, not only written down.

**Shape**

1. **One event per unit of work:** an HTTP request, a queue job, a cron run. Build it while the work runs. Emit it once at the end, whether the work succeeded or failed.
2. **Flat `snake_case` keys with primitive values.** Every log backend indexes them and every SQL engine can `group by` them. Use prefixes to group: `user_plan`, `cart_total_cents`.
3. **Middleware owns the infrastructure:** timing, trace, status, outcome and emission. Handlers only add business context with `annotate`.

**Safety**

4. **Check the field contract at runtime.** These names throw: names that are not snake_case, names reserved for the lifecycle, and names that suggest secrets or raw content (`user_email`, `api_token`, `request_body`). The last check is a heuristic, and derived names like `email_domain` or `has_email` pass. Names are static, so any test that runs the code path catches the mistake before it ships. A bad value, such as `NaN` or an object, becomes `null` instead of failing the request.
5. **Log the error type and a stable code, never the message.** Messages quote user input, emails and SQL parameters.
6. **Log the route template, not the raw path.** `/orders/:id` groups requests. Raw paths and query strings can carry tokens, such as password reset links. Annotate the IDs you need, like `order_id`.

**Meaning**

7. **Two levels.** `error` means someone should look: an unexpected error or a 5xx. Expected failures (declined card, plan limit, 4xx) end as `outcome: error` with `error_kind: expected`, at level `info`. That keeps the error rate meaningful.
8. **Environment on every event:** `service`, `service_version`, `commit_hash`, `environment`, `region`, `instance_id` and `runtime`, resolved once at startup.
9. **Split the duration.** `db_ms` and `external_ms`, with their `_count` and `_max_ms`, show where a slow request spent its time.
10. **One `trace_id` across services and queues**, carried by W3C `traceparent` in headers and in queue messages.

**Cost**

11. **Tail sampling.** Decide after the work finishes:
    - Keep every unexpected error, every slow event and the users you care about. Sample the rest, expected failures included.
    - Every kept event carries `sample_rate`, so `sum(1 / sample_rate)` recovers true counts.
    - The decision is derived from `trace_id`, so services sampling at the same rate keep the same traces.

## Fields

| Field                                                                                          | Set by          | Meaning                                           |
| ---------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------- |
| `timestamp`                                                                                    | lifecycle       | Start time, ISO 8601                              |
| `level`                                                                                        | lifecycle       | `error` only for unexpected failures              |
| `operation`, `kind`                                                                            | lifecycle       | `POST /checkout` / `http`, `send_receipt` / `job` |
| `outcome`                                                                                      | lifecycle       | `success` or `error`                              |
| `error_kind`                                                                                   | lifecycle       | `expected`, `unexpected` or `interrupted`         |
| `error_type`, `error_code`                                                                     | lifecycle       | Error class or `_tag`, and a stable code          |
| `duration_ms`                                                                                  | lifecycle       | The whole unit of work                            |
| `<name>_count`, `<name>_ms`, `<name>_max_ms`                                                   | `timed(name)`   | Time spent waiting on `db`, `external`, ...       |
| `http_method`, `http_route`, `status_code`                                                     | HTTP middleware | The route template, never the raw path            |
| `request_id`, `user_agent`                                                                     | HTTP middleware | From the `x-request-id` and `user-agent` headers  |
| `trace_id`, `span_id`, `parent_span_id`                                                        | lifecycle       | W3C trace context                                 |
| `service`, `service_version`, `commit_hash`, `environment`, `region`, `instance_id`, `runtime` | startup         | What code ran, and where                          |
| `sample_rate`                                                                                  | sampler         | Present when a sampling sink is used              |
| anything else                                                                                  | you             | Business context, through `annotate`              |

The environment fields come from these variables, first match wins. With no match, the field is `null`.

- `service_version`: `SERVICE_VERSION`, `npm_package_version`
- `commit_hash`: `COMMIT_SHA`, `GIT_COMMIT`, `VERCEL_GIT_COMMIT_SHA`, `GITHUB_SHA`, `RENDER_GIT_COMMIT`, `RAILWAY_GIT_COMMIT_SHA`
- `environment`: `APP_ENV`, `VERCEL_ENV`, `NODE_ENV`
- `region`: `REGION`, `VERCEL_REGION`, `AWS_REGION`, `FLY_REGION`

## Plain or Effect

Both versions emit the same events from the same `core/`. The difference is how the current event travels and how failures are classified.

|                             | [Plain](plain/README.md)             | [Effect](effect/README.md)                      |
| --------------------------- | ------------------------------------ | ----------------------------------------------- |
| Current event               | `AsyncLocalStorage`                  | A `WideEvent` service in the context            |
| `annotate` outside an event | Does nothing                         | Compile error                                   |
| Expected failure            | Throw an `ExpectedError` subclass    | Any typed failure in the error channel          |
| Unexpected failure          | Anything else thrown                 | A defect (`Effect.die`, `orDie`)                |
| Trace propagation           | `traceHeaders()` on outgoing `fetch` | Effect's HTTP client sends `traceparent` itself |

## Querying

Any store that can query JSON at scale works: ClickHouse, BigQuery, DuckDB, Honeycomb, Axiom, Datadog. The demo uses DuckDB on a JSONL file, so it runs with nothing else installed. See [demo/README.md](demo/README.md).

For an OpenTelemetry backend, [`otlp/`](otlp/README.md) sends each event as one OTLP log record, linked to its trace.

## Use with AI coding agents

Boris Tane's skill teaches your agent to write logging this way:

```sh
npx add-skill boristane/agent-skills
```

[AGENTS.md](AGENTS.md) holds the conventions for agents working in this repository.

## Credits

- **Boris Tane** wrote [Logging Sucks](https://loggingsucks.com), [Observability wide events 101](https://boristane.com/blog/observability-wide-events-101/) and the [`logging-best-practices`](https://github.com/boristane/agent-skills) skill. The core ideas here come from his writing: one event per request per service, high cardinality and dimensionality, business context, middleware enrichment and tail sampling.
- **Stripe** described [canonical log lines](https://stripe.com/blog/canonical-log-lines), the same pattern under another name.
- **W3C** [Trace Context](https://www.w3.org/TR/trace-context/) defines `traceparent`.

This repository adds the implementation details that held up in production: the enforced field contract, the expected and unexpected split, the duration breakdown, trace-consistent sampling, and the two versions.

## License

[MIT](LICENSE)
