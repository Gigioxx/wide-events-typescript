// A tiny fake store shared by the plain and Effect examples and the demo.
// Nothing here knows about wide events.

export type Plan = 'free' | 'pro' | 'enterprise'
export type User = { readonly id: string; readonly plan: Plan; readonly accountAgeDays: number }

export const users: ReadonlyMap<string, User> = new Map(
  Array.from({ length: 300 }, (_, index): [string, User] => {
    const id = `usr_${String(index + 1).padStart(3, '0')}`
    const plan = index % 20 === 0 ? 'enterprise' : index % 4 === 0 ? 'pro' : 'free'
    return [id, { id, plan, accountAgeDays: (index * 37) % 1500 }]
  }),
)

export const prices: ReadonlyMap<string, number> = new Map([
  ['prd_sticker', 299],
  ['prd_poster', 999],
  ['prd_mug', 1499],
  ['prd_tshirt', 2499],
  ['prd_hoodie', 5999],
])

export const coupons: ReadonlyMap<string, number> = new Map([
  ['WELCOME10', 10],
  ['SAVE15', 15],
  ['VIP25', 25],
])

export type CartItem = { readonly product_id: string; readonly quantity: number }

export type CheckoutRequest = {
  readonly user_id: string
  readonly items: ReadonlyArray<CartItem>
  readonly coupon?: string | undefined
  // A test card token, like Stripe's: `tok_visa` or `tok_declined`.
  readonly card: string
}

export type ReceiptMessage = {
  readonly order_id: string
  readonly user_id: string
  readonly enqueued_at: number
  readonly attempt: number
  // Carries the trace from the request that enqueued the job.
  readonly traceparent: string | undefined
}

export const stringField = (value: unknown, key: string) => {
  const field = typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
  return typeof field === 'string' ? field : undefined
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const jitter = (min: number, max: number) => min + Math.random() * (max - min)

export const findUser = async (id: string) => {
  await sleep(jitter(1, 4))
  return users.get(id)
}

export const subtotalCents = (items: ReadonlyArray<CartItem>) =>
  items.reduce((sum, item) => sum + (prices.get(item.product_id) ?? 0) * item.quantity, 0)

// PLANTED BUG for the demo: the new checkout flow forgets to round after the
// discount, so coupon orders can carry fractional cents.
export const totalCents = (subtotal: number, percentOff: number, newCheckout: boolean) => {
  const discounted = subtotal * (1 - percentOff / 100)
  return newCheckout ? discounted : Math.round(discounted)
}

// A feature flag with a stable per-user rollout.
export const inRollout = (userId: string, percent: number) => {
  let hash = 0
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % 100 < percent
}

// Payment provider latency, with a slow tail.
export const providerLatencyMs = () => (Math.random() < 0.02 ? jitter(800, 2500) : jitter(20, 90))
export const emailLatencyMs = () => jitter(5, 30)

// One request per outcome: success, expected failure, the planted bug, and an
// unknown user.
export const exampleRequests = (newCheckoutPercent: number): ReadonlyArray<CheckoutRequest> => {
  const ids = [...users.keys()]
  const onNewFlow = ids.find((id) => inRollout(id, newCheckoutPercent)) ?? 'usr_001'
  const onOldFlow = ids.find((id) => !inRollout(id, newCheckoutPercent)) ?? 'usr_001'
  return [
    { user_id: onOldFlow, items: [{ product_id: 'prd_mug', quantity: 2 }], card: 'tok_visa' },
    {
      user_id: onOldFlow,
      items: [{ product_id: 'prd_hoodie', quantity: 1 }],
      card: 'tok_declined',
    },
    {
      user_id: onNewFlow,
      items: [{ product_id: 'prd_tshirt', quantity: 1 }],
      coupon: 'SAVE15',
      card: 'tok_visa',
    },
    { user_id: 'usr_999', items: [{ product_id: 'prd_poster', quantity: 1 }], card: 'tok_visa' },
  ]
}
