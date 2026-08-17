import { resolveRuntimeConfig } from '@dhamani/config';
import { createApi } from './bootstrap.js';

const config = resolveRuntimeConfig();
const app = await createApi(config);
await app.listen(config.port);
