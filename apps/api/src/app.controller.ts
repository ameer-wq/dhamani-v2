import { Controller, Get, HttpCode, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { RuntimeConfig } from '@dhamani/config';
import { databaseIsReachable } from '@dhamani/db';

export const RUNTIME_CONFIG = Symbol('RUNTIME_CONFIG');

@Controller('health')
export class AppController {
  constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HttpCode(200)
  async ready(): Promise<{ status: 'ready' } | { status: 'unavailable' }> {
    if (await databaseIsReachable(this.config)) return { status: 'ready' };
    throw new ServiceUnavailableException('DATABASE_UNAVAILABLE');
  }
}
