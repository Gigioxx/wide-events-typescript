// Runs checkout, payments and the receipt worker, sends one request per
// outcome, and prints every wide event as one JSON line.
import { Effect, Layer } from 'effect'
import { HttpRouter, HttpServer } from 'effect/http'

import { stdoutSink } from '../../core/sinks'
import { type ReceiptMessage, exampleRequests } from '../../fixtures/store'
import { WideEvents } from '../WideEvent'
import { CheckoutRoutes } from './checkout'
import { PaymentsRoutes } from './payments'
import { sendReceipt } from './receipts'

const newCheckoutPercent = 50
const queue: ReceiptMessage[] = []

// `disableLogger` turns off Effect's own access log line. The wide event
// replaces it.
const payments = HttpRouter.toWebHandler(
  PaymentsRoutes.pipe(
    Layer.provide([
      WideEvents.layer({ service: 'payments', sink: stdoutSink }),
      HttpServer.layerServices,
    ]),
  ),
  { disableLogger: true },
)
const paymentsServer = Bun.serve({ port: 0, fetch: (request) => payments.handler(request) })

const checkout = HttpRouter.toWebHandler(
  CheckoutRoutes({
    paymentsUrl: paymentsServer.url.origin,
    enqueue: (message) => queue.push(message),
    newCheckoutPercent,
  }).pipe(
    Layer.provide([
      WideEvents.layer({ service: 'checkout', sink: stdoutSink }),
      HttpServer.layerServices,
    ]),
  ),
  { disableLogger: true },
)
const checkoutServer = Bun.serve({ port: 0, fetch: (request) => checkout.handler(request) })

for (const body of exampleRequests(newCheckoutPercent)) {
  await fetch(new URL('/checkout', checkoutServer.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

await Effect.runPromise(
  Effect.forEach(queue, sendReceipt, { discard: true }).pipe(
    Effect.provide(WideEvents.layer({ service: 'receipts', sink: stdoutSink })),
  ),
)

await Promise.all([
  paymentsServer.stop(),
  checkoutServer.stop(),
  payments.dispose(),
  checkout.dispose(),
])
