import { writeFileSync } from 'node:fs';
import { accounts, call, login } from './phase4-accounts.mjs';

const samples = Number(process.env.PHASE4_VOLUME_SAMPLES ?? 15);
const adminAccount = accounts.find((account) => account.role === 'ADMIN');
const superAccount = accounts.find((account) => account.role === 'SUPER_ADMIN');
const manager = accounts.find((account) => account.email === 'regression.manager.h1@volume.lab');
const stall = accounts.find((account) => account.email === 'regression.stall.h1-01@volume.lab');
const [admin, governance, hall, exhibitor] = await Promise.all([
  login(adminAccount), login(superAccount), login(manager), login(stall),
]);

const listed = await call(admin, 'GET', '/tickets?view=all&limit=20&search=HIST-');
const ticket = listed.payload?.items?.[0];
if (!ticket?.id) throw new Error('Historical list did not return a ticket');
const operations = [
  ['admin.profile', admin, 'GET', '/auth/profile'],
  ['admin.list', admin, 'GET', '/tickets?view=all&limit=50'],
  ['admin.detail', admin, 'GET', '/tickets/' + ticket.id],
  ['admin.activity', admin, 'GET', '/tickets/' + ticket.id + '/activity'],
  ['admin.metrics', admin, 'GET', '/management/metrics'],
  ['admin.audit', admin, 'GET', '/management/audit?limit=50'],
  ['admin.registrations', admin, 'GET', '/management/registrations'],
  ['manager.attention', hall, 'GET', '/tickets?view=attention&limit=50'],
  ['manager.queue', hall, 'GET', '/tickets?view=queued&limit=50'],
  ['stall.list', exhibitor, 'GET', '/tickets?view=active&limit=20'],
  ['super.portfolio', governance, 'GET', '/management/portfolio'],
  ['super.audit', governance, 'GET', '/management/audit?limit=50'],
];

const results = [];
for (let sample = 0; sample < samples; sample += 1) {
  for (const [name, cookie, method, path] of operations) {
    const result = await call(cookie, method, path);
    results.push({ name, status: result.status, ms: result.ms });
  }
}

const oversized = await call(admin, 'GET', '/management/audit?limit=500');
const first = await call(admin, 'GET', '/management/audit?limit=50&action=HIST_VOLUME_NOTE');
const second = first.payload?.nextCursor
  ? await call(admin, 'GET', '/management/audit?limit=50&action=HIST_VOLUME_NOTE&cursor=' + encodeURIComponent(first.payload.nextCursor))
  : { payload: { items: [] }, status: 0 };
const firstIds = new Set((first.payload?.items ?? []).map((item) => item.kind + ':' + item.id));
const overlap = (second.payload?.items ?? []).filter((item) => firstIds.has(item.kind + ':' + item.id)).length;
const exportJob = await call(admin, 'POST', '/management/exports', {
  format: 'CSV',
  filters: { status: 'CLOSED' },
  columns: ['ticket_number', 'status', 'created_at'],
});
let exportStatus = null;
if (exportJob.status === 201) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const jobs = await call(admin, 'GET', '/management/exports');
    exportStatus = jobs.payload?.find((job) => job.id === exportJob.payload?.id)?.status ?? null;
    if (exportStatus === 'READY' || exportStatus === 'FAILED') break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] * 10) / 10;
}

const summary = new Map();
for (const row of results) {
  const bucket = summary.get(row.name) ?? [];
  bucket.push(row);
  summary.set(row.name, bucket);
}
const latency = Object.fromEntries([...summary].map(([name, rows]) => {
  const ok = rows.filter((row) => row.status >= 200 && row.status < 300).map((row) => row.ms);
  const statuses = {};
  for (const row of rows) statuses[row.status] = (statuses[row.status] ?? 0) + 1;
  return [name, { samples: rows.length, statuses, p50: percentile(ok, 0.5), p95: percentile(ok, 0.95), p99: percentile(ok, 0.99) }];
}));

const report = {
  profile: 'historical-volume',
  ticket: ticket.publicNo,
  latency,
  auditLimit500: oversized.status,
  auditPageOverlap: overlap,
  auditFirstPage: first.payload?.items?.length ?? 0,
  auditSecondPage: second.payload?.items?.length ?? 0,
  exportStatus,
  targetP95Ms: 500,
  note: 'Local lab timings are not hosted production latency.',
};
writeFileSync(process.env.PHASE4_VOLUME_REPORT ?? 'test-results/phase4/volume-check.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (oversized.status !== 400 || overlap !== 0 || exportStatus !== 'READY' || results.some((row) => row.status >= 500 || row.status === 0)) {
  process.exitCode = 1;
}
