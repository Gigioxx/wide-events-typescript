import { Data, Effect, Layer, Schema } from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from 'effect/http'

import {
  type ReceiptMessage,
  coupons,
  findUser,
  inRollout,
  subtotalCents,
  totalCents,
} from '../../fixtures/store'
import { WideEventMiddleware } from '../http'
import { annotate, currentTraceparent, timed } from '../WideEvent'

const respond = (status: number, code: string) =>
  Effect.succeed(HttpServerResponse.jsonUnsafe({ code }, { status }))

class UnknownUser extends Schema.TaggedError<UnknownUser>()('UnknownUser', {}) {
  [HttpServerRespondable.symbol]() {
    return respond(404, 'unknown_user')
  }
}

class CardDeclined extends Schema.TaggedError<CardDeclined>()('CardDeclined', {}) {
  [HttpServerRespondable.symbol]() {
    return respond(402, 'card_declined')
  }
}

// Not a typed failure: payments rejected a charge this service built. That
// is a bug, so it is raised as a defect and the event says `unexpected`.
class PaymentFailed extends Data.TaggedError('PaymentFailed') {}

const CheckoutRequest = Schema.Struct({
  user_id: Schema.String,
  items: Schema.Array(Schema.Struct({ product_id: Schema.String, quantity: Schema.Number })),
  coupon: Schema.optional(Schema.String),
  card: Schema.String,
})
const Charge = Schema.Struct({ charge_id: Schema.String, provider: Schema.String })
const PaymentError = Schema.Struct({ code: Schema.String })

export type CheckoutOptions = {
  readonly paymentsUrl: string
  readonly enqueue: (message: ReceiptMessage) => void
  // Share of users on the new checkout flow, from 0 to 100.
  readonly newCheckoutPercent: number
}

// The handler has no logging. It states facts about the request as it learns
// them, and the middleware emits them as one event.
const checkout = (client: HttpClient.HttpClient, options: CheckoutOptions) =>
  Effect.gen(function* () {
    const body = yield* HttpServerRequest.schemaBodyJson(CheckoutRequest)

    const user = yield* Effect.promise(() => findUser(body.user_id)).pipe(timed('db'))
    if (!user) return yield* new UnknownUser()
    const newCheckout = inRollout(user.id, options.newCheckoutPercent)
    yield* annotate({
      user_id: user.id,
      user_plan: user.plan,
      user_account_age_days: user.accountAgeDays,
      flag_new_checkout: newCheckout,
    })

    const subtotal = subtotalCents(body.items)
    const total = totalCents(subtotal, coupons.get(body.coupon ?? '') ?? 0, newCheckout)
    yield* annotate({
      cart_item_count: body.items.length,
      cart_subtotal_cents: subtotal,
      cart_total_cents: total,
      coupon_code: body.coupon,
    })

    // Effect's HTTP client sends `traceparent` on its own.
    const response = yield* client
      .execute(
        HttpClientRequest.post(`${options.paymentsUrl}/charges`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ amount_cents: total, card: body.card }),
        ),
      )
      .pipe(timed('external'))
    yield* annotate({ payment_status_code: response.status })
    if (response.status === 402) return yield* new CardDeclined()
    if (response.status >= 400) {
      const { code } = yield* HttpClientResponse.schemaBodyJson(PaymentError)(response).pipe(
        Effect.orDie,
      )
      yield* annotate({ payment_error_code: code })
      return yield* Effect.die(new PaymentFailed())
    }
    // A malformed answer from payments is a defect, not a bad client request.
    const charge = yield* HttpClientResponse.schemaBodyJson(Charge)(response).pipe(Effect.orDie)

    const orderId = `ord_${crypto.randomUUID().slice(0, 8)}`
    yield* annotate({
      order_id: orderId,
      charge_id: charge.charge_id,
      payment_provider: charge.provider,
    })
    const traceparent = yield* currentTraceparent
    yield* Effect.sync(() =>
      options.enqueue({
        order_id: orderId,
        user_id: user.id,
        enqueued_at: Date.now(),
        attempt: 1,
        traceparent,
      }),
    )
    return HttpServerResponse.jsonUnsafe({ order_id: orderId }, { status: 201 })
  })

export const CheckoutRoutes = (options: CheckoutOptions) =>
  HttpRouter.addAll(
    Effect.map(Effect.service(HttpClient.HttpClient), (client) => [
      HttpRouter.route('POST', '/checkout', checkout(client, options)),
    ]),
  ).pipe(Layer.provide(WideEventMiddleware), Layer.provide(FetchHttpClient.layer))
