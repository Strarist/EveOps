import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { correlationId } from './request-context';

@Catch()
export class SanitizedExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SanitizedExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const id = correlationId();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? payload
          : Array.isArray((payload as { message?: unknown }).message)
            ? (payload as { message: string[] }).message
            : (payload as { message?: string }).message ?? exception.message;
      response.status(status).json({
        statusCode: status,
        message,
        correlationId: id,
      });
      return;
    }

    const detail =
      exception instanceof Error
        ? { name: exception.name, message: exception.message, stack: exception.stack }
        : { message: String(exception) };
    this.logger.error(
      JSON.stringify({
        type: 'http.unhandled',
        correlationId: id,
        method: request.method,
        path: request.path,
        ...detail,
      }),
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      correlationId: id,
    });
  }
}
