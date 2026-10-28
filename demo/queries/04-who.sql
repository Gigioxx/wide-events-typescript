-- 4. Who is affected? Slice release 1.5.0 by feature flag and coupon.
--    Nobody planned this question. The fields were there anyway.
select
  flag_new_checkout,
  coupon_code is not null as has_coupon,
  count(*) as requests,
  count(*) filter (where error_type = 'PaymentFailed') as payment_failures
from events
where service = 'checkout' and service_version = '1.5.0' and user_id is not null
group by all
order by all;
