import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { resolveRuntimeConfig } from '../../packages/config/src/index.ts';
import { createApi } from '../../apps/api/src/bootstrap.ts';
import { pass } from './lib.ts';

const baseConfig = resolveRuntimeConfig();
const baseUrl = new URL(baseConfig.database.url);
const runtimeUrl = new URL(baseConfig.database.url);
runtimeUrl.pathname = `${runtimeUrl.pathname.replace(/^\//, '')}_spec001_evidence`;
runtimeUrl.username = 'dhamani_runtime';
runtimeUrl.password = process.env.SPEC001_RUNTIME_PASSWORD ?? 'runtime_test_only';
const runtimeDatabaseUrl = runtimeUrl.toString();

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 }).trim();
}

/**
 * Resolves the PostgreSQL container that this probe will stop, and PROVES it is the same cluster
 * the application's `DATABASE_URL` actually reaches.
 *
 * Without this proof the outage step is meaningless: stopping one container while the application
 * connects to a different PostgreSQL published on another host port produces a "readiness stayed
 * healthy" result that says nothing about the application. The cluster's `system_identifier` is
 * assigned at initdb and is unique per data directory, so comparing the value observed over the
 * runtime TCP URL with the value read from inside the container is a positive identity match
 * rather than an assumption based on names or ports.
 */
function resolveBackingContainer(): string {
  const named = process.env.SPEC001_PG_CONTAINER;
  const resolved = named ?? docker('compose', 'ps', '-q', 'postgres');
  const container = resolved.split(/\r?\n/)[0]?.trim();
  if (!container) throw new Error('no PostgreSQL container resolved for the readiness probe');
  return container;
}

async function clusterIdentityOverUrl(connectionString: string): Promise<string> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const result = await client.query<{ id: string }>(
      'SELECT system_identifier::text AS id FROM pg_control_system()',
    );
    return result.rows[0]!.id;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function clusterIdentityInsideContainer(container: string): string {
  return docker(
    'exec',
    container,
    'psql',
    '-U',
    decodeURIComponent(baseUrl.username),
    '-d',
    'postgres',
    '-tAc',
    'SELECT system_identifier::text FROM pg_control_system()',
  );
}

/**
 * Fail-closed binding proof executed before any outage is attempted. Returns the recorded facts so
 * the evidence states the exact container/port/version the transition was proven against.
 */
async function proveContainerBacksRuntimeUrl(container: string): Promise<Record<string, string>> {
  const overUrl = await clusterIdentityOverUrl(runtimeDatabaseUrl);
  const inside = clusterIdentityInsideContainer(container);
  if (overUrl !== inside)
    throw new Error(
      `the container being stopped does not back the application DATABASE_URL: ` +
        `url ${runtimeUrl.hostname}:${runtimeUrl.port || '5432'} reports cluster ${overUrl} ` +
        `while container ${container} reports cluster ${inside}`,
    );
  const publishedPort = docker(
    'inspect',
    '-f',
    '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
    container,
  );
  const expectedPort = runtimeUrl.port || '5432';
  if (publishedPort !== expectedPort)
    throw new Error(
      `container ${container} publishes host port ${publishedPort} but the runtime URL targets ${expectedPort}`,
    );
  return {
    container,
    containerId: docker('inspect', '-f', '{{.Id}}', container),
    publishedHostPort: publishedPort,
    clusterSystemIdentifier: overUrl,
    startedAt: docker('inspect', '-f', '{{.State.StartedAt}}', container),
  };
}
// SPEC-000 still proves reachability loss/recovery, but after SPEC-001 the real application is
// permitted to become ready only with the constrained contractual-write credential.
// Set the process's actual DATABASE_URL before resolving the application config: the real route
// and the independent connectivity check below therefore share exactly one credential/endpoint.
process.env.DATABASE_URL = runtimeDatabaseUrl;
const config = resolveRuntimeConfig();
const app = await createApi(config);
await app.listen(0);
const address = app.getHttpServer().address() as { port: number };
const ready = () => fetch(`http://127.0.0.1:${address.port}/health/ready`);

async function freshDatabaseConnectionIsUsable(): Promise<boolean> {
  const client = new pg.Client({
    connectionString: runtimeDatabaseUrl,
    connectionTimeoutMillis: 3000,
  });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const result = await client.query<{ reachable: number }>('SELECT 1::int AS reachable');
    return result.rows[0]?.reachable === 1;
  } catch {
    return false;
  } finally {
    // node-postgres owns teardown after a rejected connect. Calling end() on that same failed
    // connection can race its Windows socket close; only close clients that actually connected.
    if (connected) await client.end().catch(() => undefined);
  }
}

async function waitForDatabaseUnavailable(): Promise<number | undefined> {
  // Docker can report the container stopped just before its Windows port-forward stops accepting
  // new connections. Synchronize on the contractual condition itself, not an arbitrary delay.
  for (let attempt = 1; attempt <= 120; attempt += 1) {
    if (!(await freshDatabaseConnectionIsUsable())) return attempt;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

async function waitForHealthyReadiness(): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      if ((await ready()).status === 200) return true;
    } catch {
      // The application remains live during this probe; a transient fetch failure is still not a
      // healthy readiness result and is retried only while PostgreSQL is starting.
    }
  }
  return false;
}

const failures: string[] = [];
let postgresStopAttempted = false;
let bindingFacts: Record<string, string> | undefined;
const backingContainer = resolveBackingContainer();
try {
  console.log(
    JSON.stringify({
      check: 'spec000_readiness_dependency_target',
      host: runtimeUrl.hostname,
      port: runtimeUrl.port || '5432',
      database: runtimeUrl.pathname.replace(/^\//, ''),
      user: runtimeUrl.username,
    }),
  );
  // The outage is only meaningful against the PostgreSQL the application actually reaches.
  const binding = await proveContainerBacksRuntimeUrl(backingContainer);
  bindingFacts = binding;
  console.log(
    JSON.stringify({ check: 'spec000_readiness_backing_container_verified', ...binding }),
  );
  if (!(await freshDatabaseConnectionIsUsable()))
    throw new Error('actual runtime PostgreSQL credential is unusable before the stop probe');
  if ((await ready()).status !== 200)
    throw new Error('readiness not successful with reachable PostgreSQL');
  postgresStopAttempted = true;
  execFileSync('docker', ['stop', backingContainer], { stdio: 'inherit' });
  const unavailableAttempt = await waitForDatabaseUnavailable();
  if (unavailableAttempt === undefined)
    throw new Error(
      'stopping the named PostgreSQL container did not make the actual runtime DATABASE_URL unavailable',
    );
  console.log(
    JSON.stringify({
      check: 'spec000_runtime_database_became_unavailable',
      status: 'pass',
      attempts: unavailableAttempt,
    }),
  );
  if ((await ready()).status !== 503)
    throw new Error('readiness did not become 503 with PostgreSQL unavailable');
  execFileSync('docker', ['start', backingContainer], { stdio: 'inherit' });
  if (!(await waitForHealthyReadiness()))
    throw new Error('readiness did not recover after PostgreSQL restore');
  // Recovery must be the same cluster that was stopped, not a different PostgreSQL that happened
  // to become reachable on the same host port.
  const restored = await proveContainerBacksRuntimeUrl(backingContainer);
  if (restored.clusterSystemIdentifier !== binding.clusterSystemIdentifier)
    throw new Error('readiness recovered against a different PostgreSQL cluster');
  console.log(
    JSON.stringify({
      check: 'spec000_readiness_recovered_same_cluster',
      status: 'pass',
      clusterSystemIdentifier: restored.clusterSystemIdentifier,
      startedAtBefore: binding.startedAt,
      startedAtAfter: restored.startedAt,
    }),
  );
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  // Starting an already-running container is harmless and makes every failure path restore the
  // actual PostgreSQL dependency before this script reports its verdict.
  if (postgresStopAttempted) {
    try {
      execFileSync('docker', ['start', backingContainer], { stdio: 'inherit' });
      if (!(await waitForHealthyReadiness()))
        failures.push('PostgreSQL cleanup start did not restore healthy readiness');
    } catch (error) {
      failures.push(
        `PostgreSQL cleanup start failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  try {
    await app.close();
  } catch (error) {
    failures.push(
      `application cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ status: 'fail', message: failures.join('; ') }));
  // Natural shutdown lets Node/libuv finish the asynchronous Windows handle closes initiated by
  // app.close(). `process.exit(1)` can abort while one of those handles is UV_HANDLE_CLOSING.
  process.exitCode = 1;
} else {
  pass('spec000_readiness_reflects_real_database_dependency', {
    reachable: 200,
    unavailable: 503,
    restored: 200,
    runtimeMode: config.runtimeMode,
    endpoint: `${runtimeUrl.hostname}:${runtimeUrl.port || '5432'}/${runtimeUrl.pathname.replace(/^\//, '')}`,
    runtimeUser: runtimeUrl.username,
    backingContainer: bindingFacts,
  });
}
