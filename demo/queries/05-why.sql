-- 5. Why? Follow failing checkouts into payments by trace_id.
--    Fractional cents: the new flow forgets to round after the discount.
select
  checkout.trace_id,
  checkout.cart_subtotal_cents,
  checkout.coupon_code,
  payments.charge_amount_cents,
  payments.error_code
from events checkout
join events payments on payments.trace_id = checkout.trace_id and payments.service = 'payments'
where checkout.service = 'checkout' and checkout.error_type = 'PaymentFailed'
order by checkout.timestamp
limit 5;
