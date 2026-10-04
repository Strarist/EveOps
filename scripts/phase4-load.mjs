import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { accounts, apiOrigin, call, login } from './phase4-accounts.mjs';

if (process.env.PHASE4_CONFIRM !== '1') {
  console.error('Set PHASE4_CONFIRM=1 to run this workload.');
  process.exit(1);
}

const profile = process.env.PHASE4_PROFILE ?? 'target';
const paceMin = Number(process.env.PHASE4_PACE_MIN_MS ?? (profile === 'control' ? 25000 : 8000));
const paceMax = Number(process.env.PHASE4_PACE_MAX_MS ?? (profile === 'control' ? 35000 : 15000));
const warmupMs = Number(process.env.PHASE4_WARMUP_MS ?? (profile === 'control' ? 0 : 5 * 60 * 1000));
const normalMs = Number(process.env.PHASE4_NORMAL_MS ?? (profile === 'control' ? 10 * 60 * 1000 : 10 * 60 * 1000));
const sustainedMs = Number(process.env.PHASE4_SUSTAINED_MS ?? (profile === 'control' ? 0 : 30 * 60 * 1000));
const skipBurst = process.env.PHASE4_SKIP_BURST === '1' || profile === 'control';
const meanPace = (paceMin + paceMax) / 2;
const expectedListPerMin = accounts.length * 60_000 / meanPace;
mkdirSync('test-results/phase4', { recursive: true });
const jsonl = `test-results/phase4/load-${profile}.jsonl`;
writeFileSync(jsonl, '');

const sessions = [];
for (const account of accounts) {
  sessions.push({ ...account, cookie: await login(account), sse: null, reader: null, lastEventAt: 0 });
}
let nextCreateAt = Date.now() + 20_000;
const rows = [];

function note(stage, op, result, actor) {
  const row = {
    at: new Date().toISOString(),
    stage,
    op,
    actor: actor?.role ?? '',
    status: result.status,
    ms: Math.round(result.ms),
    retryAfter: result.retryAfter ?? null,
  };
  rows.push(row);
  appendFileSync(jsonl, JSON.stringify(row) + '\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openSse(session, stage) {
  const controller = new AbortController();
  const started = performance.now();
  let status = 0;
  try {
    const response = await fetch(`${apiOrigin()}/tickets/stream/live`, {
      headers: { cookie: session.cookie, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    status = response.status;
    note(stage, 'sse-connect', { status, ms: performance.now() - started, retryAfter: response.headers.get('retry-after') }, session);
    if (!response.ok || !response.body) {
      controller.abort();
      return;
    }
    session.sse = controller;
    session.reader = response.body.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      let buffer = '';
      try {
        while (true) {
          const chunk = await session.reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.includes('ticket.updated')) {
            session.lastEventAt = Date.now();
            buffer = buffer.slice(-2000);
          }
        }
      } catch {
        // The interruption stage aborts the socket.
      }
    })();
  } catch {
    note(stage, 'sse-connect', { status, ms: performance.now() - started, retryAfter: null }, session);
  }
}

function listPath(session) {
  if (session.role === 'HALL_MANAGER') return session.hall % 2 === 0 ? '/tickets?view=queued&limit=50' : '/tickets?view=attention&limit=50';
  if (session.role === 'ADMIN' || session.role === 'SUPER_ADMIN') return '/tickets?view=all&limit=50';
  return '/tickets?view=active&limit=20';
}

async function cycle(session, stage, index) {
  note(stage, 'profile', await call(session.cookie, 'GET', '/auth/profile'), session);
  const listed = await call(session.cookie, 'GET', listPath(session));
  note(stage, 'list', listed, session);
  if (index % 4 !== 0) return;
  const firstId = listed.payload?.items?.[0]?.id;
  if (firstId && session.role !== 'STAFF') {
    note(stage, 'detail', await call(session.cookie, 'GET', `/tickets/${firstId}`), session);
  }
  if (session.role === 'STALL' && Date.now() >= nextCreateAt) {
    nextCreateAt = Date.now() + 20_000;
    const category = index % 2 === 0 ? 'ELECTRICAL' : 'HOUSE_HELP';
    note(stage, 'create', await call(session.cookie, 'POST', '/tickets', {
      category,
      subtype: category === 'ELECTRICAL' ? 'Lighting' : 'General',
      description: 'Phase 4 steady request',
      priority: 'NORMAL',
      idempotencyKey: randomUUID(),
    }), session);
  } else if (session.role === 'STAFF') {
    const ticket = (listed.payload?.items ?? []).find((item) => ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'AWAITING_OTP'].includes(item.status));
    if (!ticket) return;
    const detail = await call(session.cookie, 'GET', `/tickets/${ticket.id}`);
    note(stage, 'detail', detail, session);
    if (ticket.status === 'AWAITING_OTP' || detail.payload?.status === 'AWAITING_OTP') {
      const stallCode = String(detail.payload?.stall?.stallCode ?? detail.payload?.locationParts?.stall ?? '').toUpperCase();
      const owner = sessions.find((item) => item.stall === stallCode);
      if (!owner) return;
      const otp = await call(owner.cookie, 'GET', `/tickets/${ticket.id}/otp`);
      note(stage, 'otp', otp, owner);
      if (typeof otp.payload?.otp === 'string') {
        note(stage, 'verify', await call(session.cookie, 'POST', `/tickets/${ticket.id}/otp/verify`, { otp: otp.payload.otp }), session);
      }
      return;
    }
    const next = ticket.status === 'ACCEPTED' ? 'IN_PROGRESS' : ticket.status === 'IN_PROGRESS' ? 'AWAITING_OTP' : 'ACCEPTED';
    note(stage, 'transition', await call(session.cookie, 'POST', `/tickets/${ticket.id}/transition`, { to: next }), session);
  } else if (session.role === 'HALL_MANAGER') {
    note(stage, 'metrics', await call(session.cookie, 'GET', '/management/metrics'), session);
    note(stage, 'exceptions', await call(session.cookie, 'GET', '/management/exceptions'), session);
  } else if (session.role === 'ADMIN') {
    note(stage, 'metrics', await call(session.cookie, 'GET', '/management/metrics'), session);
    note(stage, 'audit', await call(session.cookie, 'GET', '/management/audit?limit=50'), session);
  } else if (session.role === 'SUPER_ADMIN') {
    note(stage, 'portfolio', await call(session.cookie, 'GET', '/management/portfolio'), session);
  }
}

async function runStage(stage, duration) {
  if (duration <= 0) return;
  const stop = Date.now() + duration;
  await Promise.all(sessions.map(async (session) => {
    let index = 0;
    while (Date.now() < stop) {
      await cycle(session, stage, index);
      index += 1;
      const wait = paceMin + Math.random() * (paceMax - paceMin);
      const remaining = stop - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(wait, remaining));
    }
  }));
  await invariants(stage);
}

async function burst(stage) {
  const started = Date.now();
  await Promise.all(sessions.map(async (session) => {
    note(stage, 'list', await call(session.cookie, 'GET', '/tickets?view=active&limit=20'), session);
  }));
  const elapsed = Date.now() - started;
  appendFileSync(jsonl, JSON.stringify({ stage, op: 'burst-window', ms: elapsed, actors: sessions.length }) + '\n');
  if (elapsed > 2000) console.log(`${stage} spread ${elapsed}ms`);
}

function ps(pid) {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', '%cpu=,rss='], (error, stdout) => {
      if (error) return resolve(null);
      const [cpu, rss] = stdout.trim().split(/\s+/);
      resolve({ cpu: Number(cpu), rssKb: Number(rss) });
    });
  });
}

async function sampleResources() {
  let pids = {};
  try { pids = JSON.parse(readFileSync('.local/phase4/lab.json', 'utf8')).pids ?? {}; } catch { pids = {}; }
  const [api, worker, web, load] = await Promise.all([
    ps(pids.api), ps(pids.worker), ps(pids.web), ps(process.pid),
  ]);
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const activity = await client.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`);
  const backlog = await client.query(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE "processedAt" IS NULL AND "deadLetteredAt" IS NULL`);
  await client.end();
  const sample = { at: new Date().toISOString(), api, worker, web, loadGenerator: load, dbConnections: activity.rows[0].n, outboxBacklog: backlog.rows[0].n };
  appendFileSync(jsonl, JSON.stringify({ op: 'resources', ...sample }) + '\n');
  return sample;
}

async function invariants(stage) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const duplicate = await client.query(`SELECT count(*)::int AS n FROM (SELECT "ticketId" FROM "Assignment" WHERE status IN ('ACTIVE','ACCEPTED') GROUP BY "ticketId" HAVING count(*) > 1) s`);
  const capacity = await client.query(`SELECT count(*)::int AS n FROM (SELECT "staffId" FROM "Assignment" WHERE status IN ('ACTIVE','ACCEPTED') AND "activeTicketKey" IS NOT NULL GROUP BY "staffId" HAVING count(*) > 1) s`);
  const idempotency = await client.query(`SELECT count(*)::int AS n FROM (SELECT "createdById", "idempotencyKey" FROM "Ticket" GROUP BY 1, 2 HAVING count(*) > 1) s`);
  await client.end();
  const row = { stage, duplicateAssignees: duplicate.rows[0].n, overCapacity: capacity.rows[0].n, duplicateIdempotency: idempotency.rows[0].n };
  appendFileSync(jsonl, JSON.stringify({ op: 'invariants', ...row }) + '\n');
  return row;
}

const realtimeRoles = new Set(['STALL', 'STAFF', 'HALL_MANAGER', 'ADMIN']);
await Promise.all(sessions.filter((session) => realtimeRoles.has(session.role)).map((session) => openSse(session, 'connect')));
const resourceSamples = [];
const sampler = setInterval(() => { void sampleResources().then((sample) => resourceSamples.push(sample)); }, 30_000);
console.log(JSON.stringify({
  profile,
  actors: sessions.length,
  paceMs: [paceMin, paceMax],
  expectedListRequestsPerMinute: Math.round(expectedListPerMin),
  sharedListBudgetPerMinute: 120,
  pacingExceedsSharedListBudget: expectedListPerMin > 120,
  durationsMs: { warmupMs, normalMs, sustainedMs },
}));

await runStage('warmup', warmupMs);
await runStage('normal', normalMs);
if (!skipBurst) {
  await burst('burst-1');
  await sleep(5_000);
  await burst('burst-2');
}
for (const session of sessions) {
  session.sse?.abort();
  session.sse = null;
  session.reader = null;
}
await sleep(30_000);
const recoveryStarted = Date.now();
await Promise.all(sessions.filter((session) => realtimeRoles.has(session.role)).map((session) => openSse(session, 'recovery')));
const recoveryMs = Date.now() - recoveryStarted;
appendFileSync(jsonl, JSON.stringify({ op: 'sse-recovery', ms: recoveryMs }) + '\n');
await runStage('sustained', sustainedMs);
clearInterval(sampler);
await sampleResources().then((sample) => resourceSamples.push(sample));
const finalInvariants = await invariants('final');

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}
const groups = new Map();
for (const row of rows) {
  const key = `${row.stage}:${row.op}`;
  const bucket = groups.get(key) ?? [];
  bucket.push(row);
  groups.set(key, bucket);
}
const operations = Object.fromEntries([...groups].map(([key, bucket]) => {
  const ok = bucket.filter((row) => row.status >= 200 && row.status < 300).map((row) => row.ms);
  const statuses = {};
  for (const row of bucket) statuses[row.status] = (statuses[row.status] ?? 0) + 1;
  return [key, { samples: bucket.length, statuses, p50: percentile(ok, 0.5), p95: percentile(ok, 0.95), p99: percentile(ok, 0.99) }];
}));
const report = {
  profile,
  expectedListRequestsPerMinute: Math.round(expectedListPerMin),
  sharedListBudgetPerMinute: 120,
  pacingExceedsSharedListBudget: expectedListPerMin > 120,
  requests: rows.length,
  throttled: rows.filter((row) => row.status === 429).length,
  unexpected: rows.filter((row) => row.status === 0 || row.status >= 500).length,
  operations,
  recoveryMs,
  invariants: finalInvariants,
  resources: resourceSamples,
  targetP95Ms: { profile: 500, list: 500, detail: 500 },
  note: 'Local lab timings are not hosted production latency. 429 responses are retained.',
};
writeFileSync(`test-results/phase4/load-${profile}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ profile, requests: report.requests, throttled: report.throttled, unexpected: report.unexpected, invariants: finalInvariants }, null, 2));
if (report.unexpected || finalInvariants.duplicateAssignees || finalInvariants.overCapacity || finalInvariants.duplicateIdempotency) process.exitCode = 1;
