import { Module } from '@nestjs/common';
import type { RuntimeConfig } from '@dhamani/config';
import { AppController, RUNTIME_CONFIG } from './app.controller.js';

@Module({ controllers: [AppController] })
export class AppModule {
  static withConfig(config: RuntimeConfig) {
    return { module: AppModule, providers: [{ provide: RUNTIME_CONFIG, useValue: config }] };
  }
}
