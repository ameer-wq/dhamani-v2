import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import type { RuntimeConfig } from '@dhamani/config';
import { createLogger } from '@dhamani/observability';
import { AppModule } from './app.module.js';

export async function createApi(
  config: RuntimeConfig,
  destination?: NodeJS.WritableStream,
): Promise<INestApplication> {
  const logger = createLogger(config, destination as never);
  const app = await NestFactory.create(AppModule.withConfig(config), { logger: false });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId =
      typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : randomUUID();
    res.setHeader('x-request-id', requestId);
    res.on('finish', () =>
      logger.info(
        {
          requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          privateSentinel: config.privateSentinel,
        },
        'request completed',
      ),
    );
    next();
  });
  return app;
}
