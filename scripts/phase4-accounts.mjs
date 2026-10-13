export const accounts = [
  { email: 'regression.admin@volume.lab', role: 'ADMIN', portal: 'OPERATIONS' },
  { email: 'regression.super@volume.lab', role: 'SUPER_ADMIN', portal: 'GOVERNANCE' },
  ...[1, 2, 3, 4].map((hall) => ({ email: `regression.manager.h${hall}@volume.lab`, role: 'HALL_MANAGER', portal: 'OPERATIONS', hall })),
  ...['h1-01', 'h1-02', 'h1-03', 'h1-04', 'h1-05', 'h2-01', 'h2-02', 'h2-03', 'h2-04', 'h2-05', 'h3-01', 'h3-02', 'h3-03', 'h3-04', 'h4-01', 'h4-02', 'h4-03', 'h4-04'].map((code) => ({
    email: `regression.stall.${code}@volume.lab`,
    role: 'STALL',
    portal: 'OPERATIONS',
    stall: code.toUpperCase(),
  })),
  ...[1, 2, 3, 4].flatMap((hall) => [1, 2].map((slot) => ({ email: `regression.elec.h${hall}.${slot}@volume.lab`, role: 'STAFF', portal: 'OPERATIONS', service: 'ELECTRICAL' }))),
  ...[1, 2, 3, 4].flatMap((hall) => [1, 2].map((slot) => ({ email: `regression.help.h${hall}.${slot}@volume.lab`, role: 'STAFF', portal: 'OPERATIONS', service: 'HOUSE_HELP' }))),
];

export function apiOrigin() {
  return (process.env.PHASE4_API_URL ?? process.env.API_URL ?? 'http://127.0.0.1:4100/api').replace(/\/$/, '');
}

export function regressionLoginId(email) {
  return email.replace(/@volume\.lab$/, '').replace(/^regression\./, '').replaceAll('.', '-');
}

export async function login(account) {
  const password = process.env.REGRESSION_FIXTURE_PASSWORD ?? '';
  if (!/^[0-9]{4,7}$/.test(password)) throw new Error('REGRESSION_FIXTURE_PASSWORD must be 4–7 digits');
  const userId = account.userId ?? regressionLoginId(account.email);
  let response;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    response = await fetch(`${apiOrigin()}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, password, portal: account.portal }),
    });
    if (response.status !== 429) break;
    const retryAfter = Number(response.headers.get('retry-after') ?? '60');
    const wait = Math.min(120_000, (Number.isFinite(retryAfter) ? retryAfter : 60) * 1000 + Math.floor(Math.random() * 1000));
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  if (!response?.ok) throw new Error(`${account.role} login returned ${response?.status ?? 0}`);
  const header = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie().find((line) => line.startsWith('eveops_session='))
    : response.headers.get('set-cookie');
  const cookie = header?.split(';', 1)[0] ?? '';
  if (!cookie.startsWith('eveops_session=')) throw new Error(`${account.email} login did not set a session`);
  return cookie;
}

export async function call(cookie, method, path, body) {
  const started = performance.now();
  let status = 0;
  let retryAfter = null;
  let payload = null;
  try {
    const response = await fetch(`${apiOrigin()}${path}`, {
      method,
      headers: {
        cookie,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    status = response.status;
    retryAfter = response.headers.get('retry-after');
    const text = await response.text();
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = null; }
    }
  } catch {
    status = 0;
  }
  return { status, ms: performance.now() - started, retryAfter, payload };
}
