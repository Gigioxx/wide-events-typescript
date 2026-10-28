import type { WideEventRecord } from './contract'

type Env = Readonly<Record<string, string | undefined>>

const first = (...values: ReadonlyArray<string | undefined>) =>
  values.find((value) => value !== undefined && value !== '') ?? null

// One ID per process: tells instances apart and makes cold starts visible.
const instanceId = crypto.randomUUID()

// Resolve once at startup and spread into every event, so each event answers
// "which build, where, on which instance" without a join.
export const environmentFields = (service: string, env: Env = process.env): WideEventRecord => ({
  service,
  service_version: first(env.SERVICE_VERSION, env.npm_package_version),
  commit_hash: first(
    env.COMMIT_SHA,
    env.GIT_COMMIT,
    env.VERCEL_GIT_COMMIT_SHA,
    env.GITHUB_SHA,
    env.RENDER_GIT_COMMIT,
    env.RAILWAY_GIT_COMMIT_SHA,
  ),
  environment: first(env.APP_ENV, env.VERCEL_ENV, env.NODE_ENV),
  region: first(env.REGION, env.VERCEL_REGION, env.AWS_REGION, env.FLY_REGION),
  instance_id: instanceId,
  runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`,
})
