# AGENTS.md

This repository is a reference implementation of wide events in TypeScript. Readers copy its code, so keep it small, readable and correct.

## Layout

- `core/`: the shared contract, with no dependencies. Both versions build on it.
- `plain/`: the `AsyncLocalStorage` lifecycle and Hono middleware.
- `effect/`: the Effect 4 services and `HttpRouter` middleware.
- `otlp/`: a sink that exports events as OpenTelemetry log records.
- `fixtures/`: the fake store for the examples. It must not import wide event code.
- `demo/`: the simulator and the DuckDB queries.

## Commands

- `bun run check`: typecheck, lint, format check and tests. Run it before every commit.
- `bun run plain`, `bun run effect`, `bun run demo`: run the examples. CI runs them too.
- `bun run format`: format with oxfmt.

## Conventions

- Field names are flat `snake_case` with primitive values. `core/contract.ts` enforces this.
- Handlers never log. They call `annotate`, and middleware or `run`/`withWideEvent` emits.
- Log error types and stable codes, never error messages.
- A change to `core/` must keep the plain and Effect versions emitting the same fields.
- Tests prove behavior through the real lifecycle. Do not add tests that only mirror an implementation.
- Comments explain why, not what.

For logging guidance in general, install Boris Tane's skill: `npx add-skill boristane/agent-skills`.
