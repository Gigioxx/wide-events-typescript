-- 1. Is anything wrong? Unexpected errors per service.
select
  service,
  count(*) as events,
  count(*) filter (where level = 'error') as errors,
  round(100.0 * count(*) filter (where level = 'error') / count(*), 2) as error_pct
from events
group by service
order by service;
