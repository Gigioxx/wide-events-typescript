-- 7. Bonus: where does the time go? Duration split into waiting on others.
select
  service,
  round(quantile_cont(duration_ms, 0.5), 1) as p50_ms,
  round(quantile_cont(duration_ms, 0.99), 1) as p99_ms,
  round(avg(db_ms), 1) as avg_db_ms,
  round(avg(external_ms), 1) as avg_external_ms,
  round(avg(provider_ms), 1) as avg_provider_ms,
  count(*) filter (where duration_ms >= 800) as slow
from events
group by service
order by service;
