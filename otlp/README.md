# OTLP

Send wide events to any OpenTelemetry backend as OTLP log records. [`sink.ts`](sink.ts) is one function, and both versions accept it as their sink.

## Set up once

```ts
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'

import { createWideEvents } from '../plain/wide-events'
import { otlpSink } from './sink'

export const provider = new LoggerProvider({
  resource: resourceFromAttributes({ 'service.name': 'checkout' }),
  processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
})

export const wideEvents = createWideEvents({
  service: 'checkout',
  sink: otlpSink(provider.getLogger('wide-events')),
})
```

For Effect, pass the same sink to `WideEvents.layer({ service: 'checkout', sink })`.

The exporter reads the standard variables, such as `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS`. It batches records, so call `provider.shutdown()` after the server stops to flush the last ones.

## Mapping

| Log record                       | From the wide event                            |
| -------------------------------- | ---------------------------------------------- |
| `timestamp`                      | `timestamp`, the start of the work             |
| `severityNumber`, `severityText` | `ERROR` when `level` is `error`, else `INFO`   |
| `body`                           | `operation`                                    |
| `attributes`                     | Every field, unchanged                         |
| `traceId`, `spanId`              | `trace_id`, `span_id`, so the backend links it |

Field names stay flat `snake_case`, not OpenTelemetry semantic conventions like `http.request.method`. Rename them in the sink if your backend needs that.

[`otlp.test.ts`](otlp.test.ts) runs an event through the real OTLP/HTTP exporter into a fake collector and checks the record it receives.

## Without code changes

Keep the default stdout sink and let the OpenTelemetry Collector read the JSON lines with its `filelog` receiver, then export them over OTLP.
