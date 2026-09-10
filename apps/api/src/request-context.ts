import type { NextFunction, Request, Response } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const requestStorage = new AsyncLocalStorage<{ correlationId: string }>();

export function requestContext(request: Request, response: Response, next: NextFunction) {
  const supplied = request.header('x-correlation-id');
  const correlationId = supplied && /^[a-zA-Z0-9._:-]{8,128}$/.test(supplied) ? supplied : randomUUID();
  const startedAt = process.hrtime.bigint();
  response.setHeader('x-correlation-id', correlationId);
  response.on('finish', () => {
    if (request.path.endsWith('/system/health')) return;
    console.log(JSON.stringify({
      type: 'http.request',
      correlationId,
      method: request.method,
      path: request.path,
      statusCode: response.statusCode,
      durationMilliseconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
    }));
  });
  requestStorage.run({ correlationId }, next);
}

export function correlationId() {
  return requestStorage.getStore()?.correlationId ?? randomUUID();
}
