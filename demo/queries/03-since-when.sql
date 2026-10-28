-- 3. Since when? Checkout errors per release.
select
  service_version,
  commit_hash,
  count(*) as requests,
  count(*) filter (where level = 'error') as errors,
  round(100.0 * count(*) filter (where level = 'error') / count(*), 2) as error_pct
from events
where service = 'checkout'
group by all
order by service_version;
