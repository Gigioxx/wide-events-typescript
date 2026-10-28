import { type Failure, describeError } from '../core/contract'

// A failure the product handles on purpose: declined card, plan limit,
// invalid input. It ends the event with `error_kind: expected` at info level,
// so it never pages anyone. Subclass it per business case.
export class ExpectedError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code)
    this.name = new.target.name
  }
}

export const classifyError = (error: unknown): Failure => {
  const description = describeError(error)
  if (error instanceof ExpectedError) return { error_kind: 'expected', ...description }
  if (error instanceof Error && error.name === 'AbortError') {
    return { error_kind: 'interrupted', ...description }
  }
  // Only errors marked as expected count as expected. An upstream 401 or 429
  // that escapes is an outage, not normal product behavior.
  return { error_kind: 'unexpected', ...description }
}
