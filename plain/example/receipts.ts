import { type ReceiptMessage, emailLatencyMs, sleep } from '../../fixtures/store'
import { type WideEvents, annotate, timed } from '../wide-events'

// One event per job delivery. The message's `traceparent` links it to the
// checkout request that enqueued it.
export const createReceiptWorker = (wideEvents: WideEvents) => (message: ReceiptMessage) =>
  wideEvents.run(
    { operation: 'send_receipt', kind: 'job', traceparent: message.traceparent ?? null },
    async () => {
      annotate({
        order_id: message.order_id,
        user_id: message.user_id,
        attempt: message.attempt,
        queue_age_ms: Date.now() - message.enqueued_at,
      })
      await timed('external', () => sleep(emailLatencyMs()))
      annotate({ receipt_channel: 'email' })
    },
  )
