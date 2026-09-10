import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

const baseUrl = (process.env.LOAD_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const durationMs = Number(process.env.LOAD_DURATION_MS ?? 15000);
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 4);
const maxRequests = Number(process.env.LOAD_MAX_REQUESTS ?? 90);
const p95LimitMs = Number(process.env.LOAD_P95_LIMIT_MS ?? 1500);
const mutate = process.env.MUTATING_LOAD === 'true';
const password = process.env.LOAD_PASSWORD ?? 'EveOpsDemo!2026';
const results = [];

async function login(email, portal = 'OPERATIONS') {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, portal }),
  });
  if (!response.ok) throw new Error(`${email} login returned ${response.status}`);
  return response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
}

async function measured(name, path, cookie, init) {
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { cookie, ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
    });
    await response.arrayBuffer();
    results.push({ name, duration: performance.now() - started, ok: response.ok, status: response.status });
    return response;
  } catch {
    results.push({ name, duration: performance.now() - started, ok: false, status: 0 });
    return null;
  }
}

const [stall, manager, admin, governance] = await Promise.all([
  login(process.env.LOAD_STALL_EMAIL ?? 'stall@eveops.test'),
  login(process.env.LOAD_MANAGER_EMAIL ?? 'manager@eveops.test'),
  login(process.env.LOAD_ADMIN_EMAIL ?? 'admin@eveops.test'),
  login(process.env.LOAD_SUPER_EMAIL ?? 'super@eveops.test', 'GOVERNANCE'),
]);

for (const [name, cookie] of [['stall', stall], ['manager', manager], ['admin', admin]]) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/tickets/stream/live`, { headers: { cookie }, signal: controller.signal });
  results.push({ name: `${name}.sse-connect`, duration: 0, ok: response.status === 200, status: response.status });
  controller.abort();
}

if (mutate) {
  await measured('stall.create', '/api/tickets', stall, {
    method: 'POST',
    body: JSON.stringify({
      category: 'ELECTRICAL',
      subtype: 'Lighting',
      description: `Operational load smoke ${new Date().toISOString()}`,
      priority: 'NORMAL',
      idempotencyKey: randomUUID(),
    }),
  });
  await measured('admin.export', '/api/management/exports', admin, {
    method: 'POST',
    body: JSON.stringify({ format: 'CSV', filters: { status: 'CLOSED' }, columns: ['ticket_number', 'status', 'created_at'] }),
  });
}

const scenarios = [
  ['stall.active', '/api/tickets?view=active&limit=20', stall],
  ['stall.closed', '/api/tickets?view=closed&limit=5', stall],
  ['manager.tickets', '/api/tickets?view=all&limit=50', manager],
  ['manager.metrics', '/api/management/metrics', manager],
  ['manager.timing', '/api/management/timing', manager],
  ['manager.workforce', '/api/workforce', manager],
  ['admin.tickets', '/api/tickets?view=all&limit=50', admin],
  ['admin.metrics', '/api/management/metrics', admin],
  ['admin.exports', '/api/management/exports', admin],
  ['governance.portfolio', '/api/management/portfolio', governance],
];

const stopAt = Date.now() + durationMs;
let requestIndex = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (Date.now() < stopAt && requestIndex < maxRequests) {
    const index = requestIndex;
    requestIndex += 1;
    const [name, path, cookie] = scenarios[index % scenarios.length];
    await measured(name, path, cookie);
  }
}));

const durations = results.map((result) => result.duration).sort((left, right) => left - right);
const failures = results.filter((result) => !result.ok);
const p95 = durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] ?? 0;
console.log(JSON.stringify({
  baseUrl,
  requests: results.length,
  failures: failures.length,
  p95Milliseconds: Math.round(p95),
  thresholds: { zeroFailures: failures.length === 0, p95WithinLimit: p95 <= p95LimitMs, p95LimitMs },
  statusCounts: Object.fromEntries([...new Set(results.map((result) => result.status))].map((status) => [status, results.filter((result) => result.status === status).length])),
}, null, 2));

if (failures.length || p95 > p95LimitMs) process.exitCode = 1;
