import { performance } from 'node:perf_hooks';

const baseUrl = process.env.LOAD_BASE_URL ?? 'http://localhost:4000/api';
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 25);
const requests = Number(process.env.LOAD_REQUESTS ?? 250);
const path = process.env.LOAD_PATH ?? '/system/health';
const cookie = process.env.LOAD_COOKIE;

const durations = [];
let failures = 0;
let cursor = 0;

async function runner() {
  while (cursor < requests) {
    cursor += 1;
    const started = performance.now();
    try {
      const response = await fetch(baseUrl + path, { headers: cookie ? { cookie } : undefined });
      if (!response.ok) failures += 1;
    } catch {
      failures += 1;
    } finally {
      durations.push(performance.now() - started);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => runner()));
durations.sort((left, right) => left - right);
const percentile = (value) => durations[Math.min(durations.length - 1, Math.floor(durations.length * value))] ?? 0;
const report = {
  target: baseUrl + path,
  requests,
  concurrency,
  failures,
  errorRate: failures / requests,
  p50Ms: Math.round(percentile(0.5) * 100) / 100,
  p95Ms: Math.round(percentile(0.95) * 100) / 100,
  p99Ms: Math.round(percentile(0.99) * 100) / 100,
};
console.log(JSON.stringify(report));
if (report.errorRate > 0.01) process.exitCode = 1;
