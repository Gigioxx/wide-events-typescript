import { Effect, Exit, Option } from 'effect'
import { HttpRouter, HttpServerError, HttpServerRequest } from 'effect/http'

import { httpFailure } from '../core/contract'
import {
  WideEvent,
  WideEvents,
  failureFromCause,
  startWideEvent,
  traceparentSpanOptions,
} from './WideEvent'

// Infrastructure lives here: span, status, outcome, emission. Handlers only
// add business context with `annotate`.
export const WideEventMiddleware = HttpRouter.middleware<{ provides: WideEvent }>()(
  Effect.gen(function* () {
    const wideEvents = yield* WideEvents

    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        // The route template groups `/orders/1` and `/orders/2` together. The
        // raw path is left out: segments can carry tokens, such as reset links.
        const { route } = yield* HttpRouter.RouteContext
        const operation = `${request.method} ${route.path}`
        // With a tracing backend installed, Effect's server already opened a
        // span from `traceparent`. Without one, continue the header here.
        const serverSpan = yield* Effect.option(Effect.currentSpan)
        const spanOptions = Option.isSome(serverSpan)
          ? {}
          : traceparentSpanOptions(request.headers.traceparent)

        return yield* Effect.gen(function* () {
          const { event, end } = yield* startWideEvent({
            operation,
            kind: 'http',
            fields: {
              http_method: request.method,
              http_route: route.path,
              request_id: request.headers['x-request-id'],
              user_agent: request.headers['user-agent'],
            },
          }).pipe(Effect.provideService(WideEvents, wideEvents))

          const exit = yield* Effect.exit(Effect.provideService(httpEffect, WideEvent, event))
          // A failure still becomes a response: the same one the server sends.
          const status = Exit.isSuccess(exit)
            ? exit.value.status
            : (yield* HttpServerError.causeResponse(exit.cause))[0].status
          yield* end(
            { status_code: status },
            httpFailure(status, Exit.isFailure(exit) ? failureFromCause(exit.cause) : undefined),
          )
          return yield* exit
        }).pipe(Effect.withSpan(operation, { kind: 'server', ...spanOptions }))
      })
  }),
).layer
