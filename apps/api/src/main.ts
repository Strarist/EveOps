import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { requestContext } from './request-context';

async function bootstrap() {
  if (process.env.NODE_ENV === 'production') {
    for (const key of ['SESSION_SECRET', 'OTP_ENCRYPTION_SECRET', 'DATABASE_URL', 'API_URL'] as const) {
      if (!process.env[key] || process.env[key]!.includes('replace-with')) {
        throw new Error(`${key} must be configured for production`);
      }
    }
    if ((process.env.SESSION_SECRET?.length ?? 0) < 32 || (process.env.OTP_ENCRYPTION_SECRET?.length ?? 0) < 32) {
      throw new Error('SESSION_SECRET and OTP_ENCRYPTION_SECRET must be at least 32 characters');
    }
    if (process.env.SESSION_SECRET === process.env.OTP_ENCRYPTION_SECRET) {
      throw new Error('OTP_ENCRYPTION_SECRET must be distinct from SESSION_SECRET');
    }
  }
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.use(requestContext);
  app.use(cookieParser());
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000', credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 4000);
}
void bootstrap();
