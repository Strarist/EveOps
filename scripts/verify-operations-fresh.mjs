#!/usr/bin/env node
/**
 * Fails if @eveops/operations dist is older than its TypeScript source.
 * Prevents API/Playwright from silently exercising stale eligibility logic.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const srcDir = join(root, 'packages/operations/src');
const distEntry = join(root, 'packages/operations/dist/index.js');

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(path));
    else if (entry.isFile() && /\.(ts|tsx|js)$/.test(entry.name)) {
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
}

if (!existsSync(srcDir)) {
  console.error('verify-operations-fresh: missing packages/operations/src');
  process.exit(1);
}
if (!existsSync(distEntry)) {
  console.error('verify-operations-fresh: packages/operations/dist/index.js is missing. Run npm run build:packages.');
  process.exit(1);
}

const srcNewest = newestMtime(srcDir);
const distMtime = statSync(distEntry).mtimeMs;
if (srcNewest > distMtime + 1000) {
  console.error(
    'verify-operations-fresh: @eveops/operations dist is older than source. Rebuild with npm run build:packages before API/test.',
  );
  process.exit(1);
}

console.log('verify-operations-fresh: OK');
