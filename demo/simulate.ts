// Simulates two releases of the checkout system with the plain version and
// writes every wide event to demo/events.jsonl.
//   1.4.0: every user on the old checkout flow.
//   1.5.0: 30% of users on the new flow, which carries the planted bug.
import { memorySink } from '../core/sinks'
import {
  type CheckoutRequest,
  type ReceiptMessage,
  coupons,
  prices,
  users,
} from '../fixtures/store'
import { createCheckoutApp } from '../plain/example/checkout'
import { createPaymentsApp } from '../plain/example/payments'
import { createReceiptWorker } from '../plain/example/receipts'
import { createWideEvents } from '../plain/wide-events'

const requestsPerRelease = 4000
const concurrency = 100

const { events, sink } = memorySink()
const userIds = [...users.keys()]
const productIds = [...prices.keys()]
const couponCodes = [...coupons.keys()]

const pick = <T>(items: ReadonlyArray<T>, fallback: T) =>
  items[Math.floor(Math.random() * items.length)] ?? fallback

const randomRequest = (): CheckoutRequest => ({
  user_id: Math.random() < 0.01 ? 'usr_999' : pick(userIds, 'usr_001'),
  items: Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () => ({
    product_id: pick(productIds, 'prd_mug'),
    quantity: 1 + Math.floor(Math.random() * 2),
  })),
  coupon: Math.random() < 0.25 ? pick(couponCodes, 'SAVE15') : undefined,
  card: Math.random() < 0.04 ? 'tok_declined' : 'tok_visa',
})

const release = async (version: string, commit: string, newCheckoutPercent: number) => {
  const env = {
    SERVICE_VERSION: version,
    COMMIT_SHA: commit,
    APP_ENV: 'production',
    REGION: 'iad1',
  }
  const queue: ReceiptMessage[] = []
  const payments = createPaymentsApp(createWideEvents({ service: 'payments', sink, env }))
  const checkout = createCheckoutApp({
    wideEvents: createWideEvents({ service: 'checkout', sink, env }),
    paymentsUrl: 'http://payments.internal',
    // In-process call. It still goes through the payments middleware and
    // carries `traceparent`, like a network call would.
    fetch: (url, init) => Promise.resolve(payments.request(url, init)),
    enqueue: (message) => queue.push(message),
    newCheckoutPercent,
  })
  const sendReceipt = createReceiptWorker(createWideEvents({ service: 'receipts', sink, env }))

  let sent = 0
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (sent < requestsPerRelease) {
        sent += 1
        await checkout.request('/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(randomRequest()),
        })
      }
    }),
  )
  await Promise.all(queue.map(sendReceipt))
}

await release('1.4.0', 'a1b2c3d', 0)
await release('1.5.0', 'e4f5a6b', 30)

const output = new URL('events.jsonl', import.meta.url)
await Bun.write(output, events.map((event) => JSON.stringify(event)).join('\n') + '\n')
console.log(`Wrote ${events.length} events to demo/events.jsonl`)
