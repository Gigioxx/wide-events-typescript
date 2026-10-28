import { expect, test } from 'bun:test'

import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'

import { annotate, createWideEvents } from '../plain/wide-events'
import { otlpSink } from './sink'

test('exports a wide event over OTLP/HTTP, linked to its trace', async () => {
  // A fake collector that records what the exporter sends.
  const requests: unknown[] = []
  const collector = Bun.serve({
    port: 0,
    fetch: async (request) => {
      requests.push({ path: new URL(request.url).pathname, body: await request.json() })
      return Response.json({})
    },
  })
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ 'service.name': 'checkout' }),
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: `${collector.url}v1/logs` }),
      }),
    ],
  })
  const wideEvents = createWideEvents({
    service: 'checkout',
    sink: otlpSink(provider.getLogger('wide-events')),
    env: {},
  })

  const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
  const job = wideEvents.run({ operation: 'charge', kind: 'job', traceparent }, async () => {
    annotate({ user_plan: 'pro', cart_total_cents: 4999 })
    throw new Error('boom')
  })
  await expect(job).rejects.toThrow('boom')
  await provider.shutdown()
  await collector.stop()

  expect(requests).toMatchObject([
    {
      path: '/v1/logs',
      body: {
        resourceLogs: [
          {
            resource: {
              attributes: [{ key: 'service.name', value: { stringValue: 'checkout' } }],
            },
            scopeLogs: [
              {
                logRecords: [
                  {
                    severityNumber: 17,
                    severityText: 'ERROR',
                    body: { stringValue: 'charge' },
                    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
                    attributes: expect.arrayContaining([
                      { key: 'outcome', value: { stringValue: 'error' } },
                      { key: 'error_kind', value: { stringValue: 'unexpected' } },
                      { key: 'user_plan', value: { stringValue: 'pro' } },
                      { key: 'cart_total_cents', value: { intValue: 4999 } },
                      { key: 'parent_span_id', value: { stringValue: '00f067aa0ba902b7' } },
                    ]),
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  ])
})
