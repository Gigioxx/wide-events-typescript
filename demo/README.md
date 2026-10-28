# Demo: find a bug you did not plan for

```sh
bun run demo
```

## What it does

1. [`simulate.ts`](simulate.ts) runs the plain example services in one process for two releases:
   - `1.4.0`: every user on the old checkout flow.
   - `1.5.0`: 30% of users on a new checkout flow.
2. It sends 4,000 random checkouts per release: random users, carts, coupons and declined cards. Every wide event goes to `demo/events.jsonl` (about 23k events).
3. [`investigate.ts`](investigate.ts) runs each query in [`queries/`](queries) with DuckDB and prints the results.

The new flow has a planted bug in [`fixtures/store.ts`](../fixtures/store.ts): it forgets to round after applying a coupon. No log line mentions it, and nobody wrote code to detect it.

## The investigation

| Step | Question            | What the events answer                                                                                                   |
| ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1    | Is anything wrong?  | Checkout has unexpected errors. Payments has none.                                                                       |
| 2    | What is failing?    | `PaymentFailed`, with `payment_error_code: invalid_amount`. Declined cards are expected and stay out of the error level. |
| 3    | Since when?         | Only release `1.5.0`, commit `e4f5a6b`.                                                                                  |
| 4    | Who is affected?    | Only `flag_new_checkout = true` together with a coupon.                                                                  |
| 5    | Why?                | Joined by `trace_id`, payments received amounts like `11336.4` cents.                                                    |
| 6    | What did it cost?   | Blocked revenue per plan, from business fields.                                                                          |
| 7    | Where does time go? | `db_ms`, `external_ms` and `provider_ms` against p50 and p99.                                                            |

Step 4 slices by a feature flag and a coupon. No dashboard or alert was built for that question. The fields were on the event, so the answer was one `group by` away.

## Your own data

The queries are plain SQL over flat fields. They run on ClickHouse or BigQuery after changing the table name. To query your own events with DuckDB:

```sql
select * from read_json_auto('events.jsonl', union_by_name = true);
```
