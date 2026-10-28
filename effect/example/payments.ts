import { Effect, Layer, Schema } from 'effect'
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from 'effect/http'

import { providerLatencyMs } from '../../fixtures/store'
import { WideEventMiddleware } from '../http'
import { annotate, timed } from '../WideEvent'

const respond = (status: number, code: string) =>
  Effect.succeed(HttpServerResponse.jsonUnsafe({ code }, { status }))

// Typed failures are the expected ones. From this service's view a bad amount
// is the caller's mistake.
class InvalidAmount extends Schema.TaggedError<InvalidAmount>()('InvalidAmount', {}) {
  [HttpServerRespondable.symbol]() {
    return respond(422, 'invalid_amount')
  }
}

class CardDeclined extends Schema.TaggedError<CardDeclined>()('CardDeclined', {}) {
  [HttpServerRespondable.symbol]() {
    return respond(402, 'card_declined')
  }
}

const ChargeRequest = Schema.Struct({ amount_cents: Schema.Number, card: Schema.String })

const charge = Effect.gen(function* () {
  const { amount_cents, card } = yield* HttpServerRequest.schemaBodyJson(ChargeRequest)
  const provider = amount_cents >= 10_000 ? 'adyen' : 'stripe'
  yield* annotate({ charge_amount_cents: amount_cents, payment_provider: provider })

  if (!Number.isInteger(amount_cents) || amount_cents <= 0) return yield* new InvalidAmount()

  yield* Effect.sleep(providerLatencyMs()).pipe(timed('provider'))
  if (card === 'tok_declined') return yield* new CardDeclined()

  const chargeId = `ch_${crypto.randomUUID().slice(0, 8)}`
  yield* annotate({ charge_id: chargeId })
  return HttpServerResponse.jsonUnsafe({ charge_id: chargeId, provider }, { status: 201 })
})

export const PaymentsRoutes = HttpRouter.add('POST', '/charges', charge).pipe(
  Layer.provide(WideEventMiddleware),
)
