import type { WideEventRecord } from './contract'
import type { Sink } from './sinks'

// Tail sampling: decide after the work finished, when the outcome is known.
export type SamplingRules = {
  // Share of ordinary events to keep, from 0 to 1.
  readonly rate: number
  // Always keep events at least this slow.
  readonly slowMs?: number
  // Always keep events your team cares about: VIP accounts, flagged rollouts.
  readonly keep?: (event: WideEventRecord) => boolean
}

// Expected failures (declined cards, 404s) are sampled like successes: they
// can be frequent, and `sum(1 / sample_rate)` still counts them.
export const sampleRate = (event: WideEventRecord, rules: SamplingRules): number => {
  if (event.level === 'error') return 1
  if (rules.slowMs !== undefined && Number(event.duration_ms) >= rules.slowMs) return 1
  if (rules.keep?.(event)) return 1
  return rules.rate
}

// Trace IDs are random, so their low bits are a uniform number in [0, 1).
// Services sampling at the same rate then keep the same traces whole. Errors
// and slow events are still decided per service.
const traceRandom = (event: WideEventRecord) =>
  typeof event.trace_id === 'string'
    ? Number.parseInt(event.trace_id.slice(-8), 16) / 2 ** 32
    : Math.random()

// Wraps a sink. Kept events carry `sample_rate`, so counts can be re-weighted:
// `sum(1 / sample_rate)` estimates the real number of events.
export const sampled = (sink: Sink, rules: SamplingRules): Sink => {
  if (!(rules.rate >= 0 && rules.rate <= 1)) throw new RangeError('rate must be between 0 and 1')
  return (event) => {
    const rate = sampleRate(event, rules)
    if (rate >= 1 || traceRandom(event) < rate) sink({ ...event, sample_rate: rate })
  }
}
