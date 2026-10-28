// The field contract every wide event follows. Flat snake_case keys and
// primitive values keep events queryable in any log backend.

export type FieldValue = string | number | boolean | null

// `undefined` means "not known": the field is skipped, so optional values can
// be passed without guards.
export type Fields = Readonly<Record<string, FieldValue | undefined>>

export type WideEventRecord = Readonly<Record<string, FieldValue>>

// expected: the product handled it on purpose (declined card, plan limit, 4xx).
// unexpected: a bug or an outage (unknown throw, Effect defect, 5xx).
// interrupted: the caller went away or the work was cancelled.
export type ErrorKind = 'expected' | 'unexpected' | 'interrupted'

export type Failure = {
  readonly error_kind: ErrorKind
  readonly error_type: string
  readonly error_code?: string | undefined
}

// Two levels only. Expected failures are normal product behavior, not alerts.
export const levelFor = (errorKind: ErrorKind | undefined): 'info' | 'error' =>
  errorKind === 'unexpected' ? 'error' : 'info'

const typeName = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/
const codeName = /^[A-Za-z0-9_.-]{1,64}$/

const property = (value: unknown, key: string) =>
  typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined

// The error's type and stable code, never its message. Messages often quote
// user input, emails or SQL parameters; type and code are enough to group.
export const describeError = (error: unknown): Pick<Failure, 'error_type' | 'error_code'> => {
  const tag = property(error, '_tag')
  const name =
    typeof tag === 'string'
      ? tag
      : error instanceof Error
        ? error.name === 'Error'
          ? error.constructor.name
          : error.name
        : typeof error
  // Library codes are safe and specific: `ECONNRESET`, Postgres `23505`.
  const code = property(error, 'code')
  return {
    error_type: typeName.test(name) ? name : 'unknown',
    ...(typeof code === 'string' && codeName.test(code) && { error_code: code }),
  }
}

// The status describes a response that failed without an error. A 5xx is
// always unexpected: the service failed to serve, whatever the error said.
export const httpFailure = (status: number, failure: Failure | undefined): Failure | undefined => {
  if (status >= 500) {
    return {
      ...failure,
      error_kind: 'unexpected',
      error_type: failure?.error_type ?? `http_${status}`,
    }
  }
  if (failure) return failure
  return status >= 400 ? { error_kind: 'expected', error_type: `http_${status}` } : undefined
}

// Written by the lifecycle and its integrations. Handlers add business
// context and cannot overwrite these by accident.
export const reservedFields: ReadonlySet<string> = new Set([
  'timestamp',
  'level',
  'operation',
  'kind',
  'outcome',
  'error_kind',
  'error_type',
  'error_code',
  'duration_ms',
  'sample_rate',
  'trace_id',
  'span_id',
  'parent_span_id',
  'request_id',
  'http_method',
  'http_route',
  'status_code',
  'user_agent',
  'service',
  'service_version',
  'commit_hash',
  'environment',
  'region',
  'instance_id',
  'runtime',
])

const fieldName = /^[a-z][a-z0-9_]{0,63}$/

// Names that usually carry secrets, personal data or raw content. A heuristic
// that catches common mistakes, not a guarantee. Derived values pass:
// `has_email`, `email_domain`, `body_bytes`, `message_count`, `card_last4`.
const sensitiveName =
  /(?:^|_)(?:password|passwd|secret|token|api_?key|private_key|authorization|cookie|email|phone|ssn|card_number|cvv|iban|body|payload|message|content|prompt|stack_trace|query_string)(?:_|$)/
const derivedName = /^(?:has|is)_|_(?:count|length|bytes|domain|type|last4)$/

const maxStringLength = 1024

export class WideEventFieldError extends Error {
  override readonly name = 'WideEventFieldError'

  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(`Invalid wide event field "${field}": ${reason}`)
  }
}

// Throws on a bad name. Names are static, so any test that runs the code path
// catches the mistake before it ships.
export const validateFields = (
  fields: Fields,
  options: { readonly allowReserved?: boolean } = {},
): Record<string, FieldValue> => {
  const valid: Record<string, FieldValue> = {}

  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (!fieldName.test(name)) throw new WideEventFieldError(name, 'name must be snake_case')
    if (sensitiveName.test(name) && !derivedName.test(name)) {
      throw new WideEventFieldError(name, 'name suggests secret, personal or raw content')
    }
    if (!options.allowReserved && reservedFields.has(name)) {
      throw new WideEventFieldError(name, 'name is reserved for the event lifecycle')
    }

    if (typeof value === 'string') {
      valid[name] = value.length > maxStringLength ? value.slice(0, maxStringLength) : value
    } else if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      valid[name] = value
    } else {
      // Values come from runtime data, so a bad one must not fail the request.
      // `Infinity`, `NaN` and objects that slipped past the types become null.
      valid[name] = null
    }
  }

  return valid
}
