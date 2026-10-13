import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { accounts, apiOrigin, call, login } from './phase4-accounts.mjs';

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + detail : ''}`);
}

const sessions = new Map();
for (const account of accounts) {
  sessions.set(account.email, { account, cookie: await login(account) });
}
const roles = {};
for (const account of accounts) roles[account.role] = (roles[account.role] ?? 0) + 1;
record('forty accounts', accounts.length === 40 && roles.ADMIN === 1 && roles.SUPER_ADMIN === 1 && roles.HALL_MANAGER === 4 && roles.STALL === 18 && roles.STAFF === 16, JSON.stringify(roles));

const stall = sessions.get('regression.stall.h1-01@volume.lab');
const otherStall = sessions.get('regression.stall.h2-01@volume.lab');
const manager = sessions.get('regression.manager.h1@volume.lab');
const admin = sessions.get('regression.admin@volume.lab');
const elec = sessions.get('regression.elec.h1.1@volume.lab');
const busyElec = sessions.get('regression.elec.h1.2@volume.lab');

const otherList = await call(otherStall.cookie, 'GET', '/tickets?view=all&limit=5');
const foreignId = otherList.payload?.items?.[0]?.id;
if (foreignId) {
  const hidden = await call(stall.cookie, 'GET', '/tickets/' + foreignId);
  record('cross-stall read denied', hidden.status === 403, String(hidden.status));
  const hiddenWrite = await call(stall.cookie, 'POST', '/tickets/' + foreignId + '/prioritize', { reason: 'Should not apply' });
  record('cross-stall write denied', hiddenWrite.status === 403 || hiddenWrite.status === 404, String(hiddenWrite.status));
} else {
  record('cross-stall read denied', false, 'no foreign ticket');
}

const key = randomUUID();
const created = await call(stall.cookie, 'POST', '/tickets', {
  category: 'HOUSE_HELP', subtype: 'General', description: 'Idempotent phase 4 request', priority: 'NORMAL', idempotencyKey: key,
});
const replay = await call(stall.cookie, 'POST', '/tickets', {
  category: 'HOUSE_HELP', subtype: 'General', description: 'Idempotent phase 4 request', priority: 'NORMAL', idempotencyKey: key,
});
record('idempotent create', created.status === 201 && replay.status === 201 && created.payload?.id && created.payload.id === replay.payload?.id, `${created.status}/${replay.status}`);

const projection = await call(stall.cookie, 'GET', '/tickets/' + created.payload.id);
const hiddenFields = JSON.stringify(projection.payload ?? {});
record('stall projection omits secrets', projection.status === 200 && !/passwordHash|otpHash|otpCiphertext|initialCredential|SESSION_SECRET/.test(hiddenFields), String(projection.status));

const originals = new Map();
for (const email of ['regression.elec.h1.1@volume.lab', 'regression.elec.h1.2@volume.lab']) {
  const me = await call(sessions.get(email).cookie, 'GET', '/workforce/me');
  originals.set(email, me.payload?.availability ?? 'ON_DUTY');
  await call(sessions.get(email).cookie, 'PATCH', '/workforce/availability', { value: 'OFF_DUTY' });
}
const beforeBusy = await call(busyElec.cookie, 'GET', '/tickets?view=active&limit=20');
const busyIds = new Set((beforeBusy.payload?.items ?? []).map((item) => item.id));

const makers = [
  ['regression.stall.h1-01@volume.lab', 'HIGH-A'],
  ['regression.stall.h1-02@volume.lab', 'HIGH-B'],
  ['regression.stall.h1-03@volume.lab', 'MEDIUM'],
  ['regression.stall.h1-05@volume.lab', 'LOW'],
];
const queued = [];
for (const [email, label] of makers) {
  const response = await call(sessions.get(email).cookie, 'POST', '/tickets', {
    category: 'ELECTRICAL', subtype: 'Lighting', description: `Phase 4 queue ${label}`, priority: 'NORMAL', idempotencyKey: randomUUID(),
  });
  queued.push({ email, label, id: response.payload?.id, publicNo: response.payload?.publicNo, status: response.status });
  await new Promise((resolve) => setTimeout(resolve, 50));
}
await new Promise((resolve) => setTimeout(resolve, 1500));
const queue = await call(manager.cookie, 'GET', '/tickets?view=queued&limit=50&category=ELECTRICAL&subtype=Lighting');
const order = (queue.payload?.items ?? []).map((item) => item.publicNo);
const expected = queued.map((item) => item.publicNo).filter(Boolean);
const positions = expected.map((number) => order.indexOf(number));
record('queue priority and FIFO', queue.status === 200 && positions.every((index) => index >= 0) && positions.every((index, place) => place === 0 || index > positions[place - 1]), order.filter((number) => expected.includes(number)).join(','));

const low = queued[3];
const override = await call(manager.cookie, 'POST', '/tickets/' + low.id + '/prioritize', { reason: 'Phase 4 reasoned override' });
const afterOverride = await call(manager.cookie, 'GET', '/tickets?view=queued&limit=50&category=ELECTRICAL&subtype=Lighting');
record('reasoned queue override', override.status === 201 || override.status === 200, `${override.status} first=${afterOverride.payload?.items?.[0]?.publicNo}`);
record('override stays first in its pool', afterOverride.payload?.items?.[0]?.id === low.id, afterOverride.payload?.items?.[0]?.publicNo ?? '');

const afterBusy = await call(busyElec.cookie, 'GET', '/tickets?view=active&limit=20');
const stillThere = [...busyIds].every((id) => (afterBusy.payload?.items ?? []).some((item) => item.id === id));
record('new work does not preempt an active assignee', stillThere, `before ${busyIds.size}`);

for (const [email, value] of originals) {
  await call(sessions.get(email).cookie, 'PATCH', '/workforce/availability', { value });
}
let mine = null;
for (let attempt = 0; attempt < 15 && !mine; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const assigned = await call(elec.cookie, 'GET', '/tickets?view=active&limit=20');
  mine = (assigned.payload?.items ?? []).find((item) => ['ASSIGNED', 'SNOOZED'].includes(item.status) && queued.some((ticket) => ticket.id === item.id));
}
if (!mine) {
  record('otp lifecycle', false, 'no assigned phase 4 ticket after restoring duty');
  record('complaint then reopen', false, 'skipped');
} else {
  const owner = sessions.get(queued.find((ticket) => ticket.id === mine.id).email);
  const accepted = await call(elec.cookie, 'POST', '/tickets/' + mine.id + '/transition', { to: 'ACCEPTED' });
  const started = await call(elec.cookie, 'POST', '/tickets/' + mine.id + '/transition', { to: 'IN_PROGRESS' });
  const waiting = await call(elec.cookie, 'POST', '/tickets/' + mine.id + '/transition', { to: 'AWAITING_OTP' });
  const otp = await call(owner.cookie, 'GET', '/tickets/' + mine.id + '/otp');
  const code = otp.payload?.otp;
  const verified = code ? await call(elec.cookie, 'POST', '/tickets/' + mine.id + '/otp/verify', { otp: code }) : { status: otp.status };
  record('otp lifecycle', [accepted, started, waiting, otp, verified].every((step) => step.status >= 200 && step.status < 300), [accepted.status, started.status, waiting.status, otp.status, verified.status].join('/'));
  const complaintKey = randomUUID();
  const complaint = await call(owner.cookie, 'POST', '/tickets/' + mine.id + '/complaints', {
    reasonCode: 'WORK_QUALITY', comment: 'Phase 4 complaint', idempotencyKey: complaintKey,
  });
  const complaintReplay = await call(owner.cookie, 'POST', '/tickets/' + mine.id + '/complaints', {
    reasonCode: 'WORK_QUALITY', comment: 'Phase 4 complaint', idempotencyKey: complaintKey,
  });
  const reopen = await call(manager.cookie, 'POST', '/tickets/' + mine.id + '/transition', { to: 'REOPENED', reason: 'Phase 4 reopen' });
  record('complaint then reopen', complaint.status < 300 && complaintReplay.status < 300 && reopen.status < 300, `${complaint.status}/${complaintReplay.status}/${reopen.status}`);
}

const zone = await call(admin.cookie, 'GET', '/management/masters');
const zoneId = zone.payload?.[0]?.halls?.find((hall) => hall.code === 'H4')?.zones?.[0]?.id;
const suffix = Date.now().toString(36);
const sourceCode = `P4S${suffix}`.slice(0, 12);
const destinationCode = `P4D${suffix}`.slice(0, 12);
if (zoneId) {
  const source = await call(admin.cookie, 'POST', '/management/registrations/with-login', {
    eventId: 'regression-event', zoneId, stallCode: sourceCode, exhibitorName: 'Transfer source',
    loginName: 'Transfer source', loginEmail: `regression.transfer.${suffix}@volume.lab`, idempotencyKey: randomUUID(),
  });
  const destination = await call(admin.cookie, 'POST', '/management/masters/stall', {
    eventId: 'regression-event', zoneId, stallCode: destinationCode, exhibitorName: 'Transfer destination', servicePriority: 'LOW',
  });
  const registrations = await call(admin.cookie, 'GET', '/management/registrations');
  const sourceId = (registrations.payload ?? []).find((row) => row.stallCode === sourceCode)?.id;
  const destinationId = destination.payload?.id;
  const transferred = sourceId && destinationId
    ? await call(admin.cookie, 'POST', `/management/registrations/${sourceId}/transfer`, { destinationStallId: destinationId, reason: 'Phase 4 transfer' })
    : { status: 0 };
  const archived = destinationId
    ? await call(admin.cookie, 'POST', `/management/registrations/${destinationId}/archive`, { reason: 'Phase 4 archive' })
    : { status: 0 };
  record('transfer and archive', source.status === 201 && transferred.status < 300 && archived.status < 300, `${source.status}/${transferred.status}/${archived.status}`);
} else {
  record('transfer and archive', false, 'zone missing');
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const duplicate = await client.query(`SELECT "ticketId" FROM "Assignment" WHERE status IN ('ACTIVE','ACCEPTED') GROUP BY "ticketId" HAVING count(*) > 1`);
const capacity = await client.query(`SELECT "staffId" FROM "Assignment" WHERE status IN ('ACTIVE','ACCEPTED') AND "activeTicketKey" IS NOT NULL GROUP BY "staffId" HAVING count(*) > 1`);
await client.end();
record('one active assignee per ticket', duplicate.rowCount === 0, String(duplicate.rowCount));
record('worker capacity', capacity.rowCount === 0, String(capacity.rowCount));

const report = { checks, passed: checks.filter((check) => check.ok).length, failed: checks.filter((check) => !check.ok).length };
writeFileSync('test-results/phase4/correctness.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: report.passed, failed: report.failed }));
if (report.failed) process.exitCode = 1;
