-- 2. What is failing? Every error, grouped by kind, type and code.
--    Expected failures (declined cards, unknown users) are normal product
--    behavior. The unexpected one is new.
select service, error_kind, error_type, error_code, payment_error_code, count(*) as events
from events
where outcome = 'error'
group by all
order by events desc;
