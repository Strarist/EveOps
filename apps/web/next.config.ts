import type { NextConfig } from 'next';
import { loadEnvConfig } from '@next/env';
import { basename, dirname, resolve } from 'node:path';

const cwd = process.cwd();
const repositoryRoot = basename(cwd) === 'web' && basename(dirname(cwd)) === 'apps' ? resolve(cwd, '../..') : cwd;
loadEnvConfig(repositoryRoot, process.env.NODE_ENV !== 'production', console, true);

if (process.env.NODE_ENV === 'production' && !process.env.API_URL) {
  throw new Error('API_URL is required for production web builds');
}
const apiUrl = process.env.API_URL ?? 'http://localhost:4000/api';
if (!URL.canParse(apiUrl)) throw new Error('API_URL must be an absolute URL');
const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@eveops/contracts'],
  async rewrites() {
    return [{ source: '/api/:path*', destination: apiUrl + '/:path*' }];
  },
};
export default nextConfig;
