import { Effect } from 'effect'

import { type ReceiptMessage, emailLatencyMs } from '../../fixtures/store'
import { annotate, timed, withWideEvent } from '../WideEvent'

// One event per job delivery. The message's `traceparent` links it to the
// checkout request that enqueued it.
export const sendReceipt = (message: ReceiptMessage) =>
  Effect.gen(function* () {
    yield* annotate({
      order_id: message.order_id,
      user_id: message.user_id,
      attempt: message.attempt,
      queue_age_ms: Date.now() - message.enqueued_at,
    })
    yield* Effect.sleep(emailLatencyMs()).pipe(timed('external'))
    yield* annotate({ receipt_channel: 'email' })
  }).pipe(
    withWideEvent({
      operation: 'send_receipt',
      kind: 'job',
      traceparent: message.traceparent ?? null,
    }),
  )
