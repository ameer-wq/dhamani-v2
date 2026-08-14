import pino, { type Logger, type LoggerOptions } from 'pino';
import type { RuntimeConfig } from '@dhamani/config';

export function createLogger(config: RuntimeConfig, destination?: pino.DestinationStream): Logger {
  const options: LoggerOptions = {
    base: { service: 'dhamani-api', runtimeMode: config.runtimeMode },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'req.body', 'privateSentinel'],
      censor: '[REDACTED]',
    },
    serializers: {
      err: (error: Error) => ({ code: error.name, message: error.message }),
    },
  };
  return pino(options, destination);
}
