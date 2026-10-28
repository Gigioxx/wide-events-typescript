import type { ErrorHandler, MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { routePath } from 'hono/route'

import { type Failure, describeError, httpFailure } from '../core/contract'
import { ExpectedError, classifyError } from './errors'
import type { WideEvents } from './wide-events'

// Expected errors answer with their status and code; anything else is a bare
// 500. The middleware still classifies the original error from `c.error`.
export const errorResponse: ErrorHandler = (error) => {
  if (error instanceof ExpectedError)
    return Response.json({ code: error.code }, { status: error.status })
  if (error instanceof HTTPException) return error.getResponse()
  return Response.json({ code: 'internal_error' }, { status: 500 })
}

// An `HTTPException` with a 4xx status is a response the app chose to send.
const classify = (error: unknown): Failure =>
  error instanceof HTTPException && error.status < 500
    ? { error_kind: 'expected', ...describeError(error) }
    : classifyError(error)

// Infrastructure lives here: timing, trace, status, outcome, emission.
// Handlers only add business context with `annotate`.
export const wideEventMiddleware =
  (wideEvents: WideEvents): MiddlewareHandler =>
  async (c, next) => {
    const event = wideEvents.start({
      operation: c.req.method,
      kind: 'http',
      traceparent: c.req.header('traceparent') ?? null,
      fields: {
        http_method: c.req.method,
        request_id: c.req.header('x-request-id'),
        user_agent: c.req.header('user-agent'),
      },
    })

    try {
      await event.run(next)
    } catch (error) {
      event.end({ status_code: 500 }, httpFailure(500, classifyError(error)))
      throw error
    }

    // The route template groups `/orders/1` and `/orders/2` together. The raw
    // path is left out: segments can carry tokens, such as reset links.
    const route = routePath(c)
    const status = c.res.status
    event.end(
      { operation: `${c.req.method} ${route}`, http_route: route, status_code: status },
      httpFailure(status, c.error ? classify(c.error) : undefined),
    )
  }
