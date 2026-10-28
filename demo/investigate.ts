// Runs every query in demo/queries against demo/events.jsonl with DuckDB and
// prints the results in order. Each query is one step of the investigation.

import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { DuckDBInstance } from '@duckdb/node-api'

const events = new URL('events.jsonl', import.meta.url)
if (!(await Bun.file(events).exists())) {
  console.error('No events yet. Run `bun run demo:simulate` first.')
  process.exit(1)
}

const instance = await DuckDBInstance.create(':memory:')
const connection = await instance.connect()
const path = fileURLToPath(events).replaceAll("'", "''")
await connection.run(
  `create view events as select * from read_json_auto('${path}', union_by_name = true)`,
)

const queries = new URL('queries/', import.meta.url)
for (const file of (await readdir(queries)).filter((name) => name.endsWith('.sql')).toSorted()) {
  const sql = await Bun.file(new URL(file, queries)).text()
  const notes = sql
    .split('\n')
    .filter((line) => line.startsWith('--'))
    .map((line) => line.slice(3))
  const result = await connection.runAndReadAll(sql)
  console.log(`\n${notes.join('\n')}`)
  console.table(result.getRowObjectsJson())
}
