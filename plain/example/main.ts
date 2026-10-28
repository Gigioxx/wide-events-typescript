// Runs checkout, payments and the receipt worker, sends one request per
// outcome, and prints every wide event as one JSON line.
import { stdoutSink } from '../../core/sinks'
import { type ReceiptMessage, exampleRequests } from '../../fixtures/store'
import { createWideEvents } from '../wide-events'
import { createCheckoutApp } from './checkout'
import { createPaymentsApp } from './payments'
import { createReceiptWorker } from './receipts'

const newCheckoutPercent = 50
const queue: ReceiptMessage[] = []

const payments = Bun.serve({
  port: 0,
  fetch: createPaymentsApp(createWideEvents({ service: 'payments', sink: stdoutSink })).fetch,
})
const checkout = Bun.serve({
  port: 0,
  fetch: createCheckoutApp({
    wideEvents: createWideEvents({ service: 'checkout', sink: stdoutSink }),
    paymentsUrl: payments.url.origin,
    enqueue: (message) => queue.push(message),
    newCheckoutPercent,
  }).fetch,
})
const sendReceipt = createReceiptWorker(createWideEvents({ service: 'receipts', sink: stdoutSink }))

for (const body of exampleRequests(newCheckoutPercent)) {
  await fetch(new URL('/checkout', checkout.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
for (const message of queue) await sendReceipt(message)

await Promise.all([payments.stop(), checkout.stop()])
