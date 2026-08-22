import {
  Controller,
  Get,
  HttpCode,
  Inject,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { RuntimeConfig } from '@dhamani/config';
import {
  createContractualWriteReadiness,
  type ContractualWriteReadiness,
} from './spec001/application-readiness.js';

export const RUNTIME_CONFIG = Symbol('RUNTIME_CONFIG');

@Controller('health')
export class AppController implements OnModuleDestroy {
  private readonly contractualWriteReadiness: ContractualWriteReadiness;

  constructor(@Inject(RUNTIME_CONFIG) config: RuntimeConfig) {
    // The readiness probe and every future contractual write are deliberately constructed from
    // the same application DATABASE_URL. A separately supplied evidence credential therefore
    // cannot mask an unsafe owner/migration credential in the real process (§24.6).
    this.contractualWriteReadiness = createContractualWriteReadiness(config.database.url);
  }

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HttpCode(200)
  async ready(): Promise<{ status: 'ready' } | { status: 'unavailable' }> {
    try {
      const verdict = await this.contractualWriteReadiness.assert();
      if (verdict.healthy) return { status: 'ready' };
    } catch {
      // Readiness is deliberately fail-closed for both connectivity and catalog inspection.
    }
    throw new ServiceUnavailableException('CONTRACTUAL_WRITE_DATABASE_UNAVAILABLE');
  }

  async onModuleDestroy(): Promise<void> {
    await this.contractualWriteReadiness.close();
  }
}
