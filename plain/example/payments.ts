import { Hono } from 'hono'

import { providerLatencyMs, sleep } from '../../fixtures/store'
import { ExpectedError } from '../errors'
import { errorResponse, wideEventMiddleware } from '../hono'
import { type WideEvents, annotate, timed } from '../wide-events'

class InvalidAmount extends ExpectedError {
  constructor() {
    super('invalid_amount', 422)
  }
}

class CardDeclined extends ExpectedError {
  constructor() {
    super('card_declined', 402)
  }
}

export const createPaymentsApp = (wideEvents: WideEvents) => {
  const app = new Hono()
  app.use(wideEventMiddleware(wideEvents))
  app.onError(errorResponse)

  app.post('/charges', async (c) => {
    // Validation is left out to keep the example about wide events.
    const { amount_cents, card } = await c.req.json<{ amount_cents: number; card: string }>()
    const provider = amount_cents >= 10_000 ? 'adyen' : 'stripe'
    annotate({ charge_amount_cents: amount_cents, payment_provider: provider })

    // From this service's view a bad amount is the caller's mistake: expected.
    if (!Number.isInteger(amount_cents) || amount_cents <= 0) throw new InvalidAmount()

    await timed('provider', () => sleep(providerLatencyMs()))
    if (card === 'tok_declined') throw new CardDeclined()

    const chargeId = `ch_${crypto.randomUUID().slice(0, 8)}`
    annotate({ charge_id: chargeId })
    return c.json({ charge_id: chargeId, provider }, 201)
  })

  return app
}
