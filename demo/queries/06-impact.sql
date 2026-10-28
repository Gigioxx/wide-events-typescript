-- 6. What did it cost? Blocked revenue by plan, from business context.
select
  user_plan,
  count(*) as failed_checkouts,
  count(distinct user_id) as users,
  round(sum(cart_total_cents) / 100, 2) as blocked_usd
from events
where service = 'checkout' and error_type = 'PaymentFailed'
group by user_plan
order by blocked_usd desc;
