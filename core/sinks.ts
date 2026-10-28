import type { WideEventRecord } from './contract'

// Where finished events go. Keep it synchronous and cheap: one JSON line to
// stdout is enough for every log platform to pick up.
export type Sink = (event: WideEventRecord) => void

// Errors go to stdout too: the level is in the line, and one stream keeps
// `| jq` and log shippers simple.
export const stdoutSink: Sink = (event) => {
  console.log(JSON.stringify(event))
}

// Telemetry must never break the request it describes. A failing sink
// reports itself on stderr and the request continues.
export const emitSafely = (sink: Sink, event: WideEventRecord) => {
  try {
    sink(event)
  } catch (error) {
    const errorType = error instanceof Error ? error.name : typeof error
    console.error(
      JSON.stringify({ level: 'error', operation: 'wide_event_sink', error_type: errorType }),
    )
  }
}

export const memorySink = () => {
  const events: WideEventRecord[] = []
  const sink: Sink = (event) => {
    events.push(event)
  }
  return { events, sink }
}
