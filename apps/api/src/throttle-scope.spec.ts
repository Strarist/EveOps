import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { AddressInfo } from 'node:net';

@Controller('probe')
class ProbeController {
  @Get('profile') profile() {
    return { ok: true };
  }

  @Get('tickets') tickets() {
    return { ok: true };
  }
}

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 2 }])],
  controllers: [ProbeController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
class ProbeModule {}

describe('request limiter scope', () => {
  it('limits one IP on one route, leaves the other route available, and sends Retry-After', async () => {
    const app = await NestFactory.create(ProbeModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}/probe`;
    const profileStatuses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      profileStatuses.push((await fetch(`${base}/profile`)).status);
    }
    expect(profileStatuses).toEqual([200, 200, 429]);
    const limited = await fetch(`${base}/profile`);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await fetch(`${base}/tickets`)).status).toBe(200);
    await app.close();
  });
});
