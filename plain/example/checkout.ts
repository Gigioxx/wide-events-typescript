import { Hono } from 'hono'

import {
  type CheckoutRequest,
  type ReceiptMessage,
  coupons,
  findUser,
  inRollout,
  stringField,
  subtotalCents,
  totalCents,
} from '../../fixtures/store'
import { ExpectedError } from '../errors'
import { errorResponse, wideEventMiddleware } from '../hono'
import { type WideEvents, annotate, currentTraceparent, timed, traceHeaders } from '../wide-events'

class UnknownUser extends ExpectedError {
  constructor() {
    super('unknown_user', 404)
  }
}

class CardDeclined extends ExpectedError {
  constructor() {
    super('card_declined', 402)
  }
}

// Not expected: payments rejected a charge this service built. That is a bug.
class PaymentFailed extends Error {}

export type CheckoutOptions = {
  readonly wideEvents: WideEvents
  readonly paymentsUrl: string
  readonly enqueue: (message: ReceiptMessage) => void
  // Share of users on the new checkout flow, from 0 to 100.
  readonly newCheckoutPercent: number
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
}

export const createCheckoutApp = (options: CheckoutOptions) => {
  const fetch = options.fetch ?? globalThis.fetch
  const app = new Hono()
  app.use(wideEventMiddleware(options.wideEvents))
  app.onError(errorResponse)

  // The handler has no logging. It states facts about the request as it
  // learns them, and the middleware emits them as one event.
  app.post('/checkout', async (c) => {
    const body = await c.req.json<CheckoutRequest>()

    const user = await timed('db', () => findUser(body.user_id))
    if (!user) throw new UnknownUser()
    const newCheckout = inRollout(user.id, options.newCheckoutPercent)
    annotate({
      user_id: user.id,
      user_plan: user.plan,
      user_account_age_days: user.accountAgeDays,
      flag_new_checkout: newCheckout,
    })

    const subtotal = subtotalCents(body.items)
    const total = totalCents(subtotal, coupons.get(body.coupon ?? '') ?? 0, newCheckout)
    annotate({
      cart_item_count: body.items.length,
      cart_subtotal_cents: subtotal,
      cart_total_cents: total,
      coupon_code: body.coupon,
    })

    const response = await timed('external', () =>
      fetch(`${options.paymentsUrl}/charges`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...traceHeaders() },
        body: JSON.stringify({ amount_cents: total, card: body.card }),
      }),
    )
    const charge: unknown = await response.json()
    annotate({ payment_status_code: response.status })
    if (response.status === 402) throw new CardDeclined()
    if (!response.ok) {
      annotate({ payment_error_code: stringField(charge, 'code') })
      throw new PaymentFailed()
    }

    const orderId = `ord_${crypto.randomUUID().slice(0, 8)}`
    annotate({
      order_id: orderId,
      charge_id: stringField(charge, 'charge_id'),
      payment_provider: stringField(charge, 'provider'),
    })
    options.enqueue({
      order_id: orderId,
      user_id: user.id,
      enqueued_at: Date.now(),
      attempt: 1,
      traceparent: currentTraceparent(),
    })
    return c.json({ order_id: orderId }, 201)
  })

  return app
}
