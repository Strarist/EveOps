import { publishedBuildIdentity } from '@eveops/contracts';

export function GET() {
  return Response.json({
    service: 'eveops-web',
    build: publishedBuildIdentity(),
    time: new Date().toISOString(),
  });
}
