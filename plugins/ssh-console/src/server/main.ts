import Fastify from 'fastify';
import { definePlugin } from '../../../../sdk/backend.mjs';
import { createSshConsoleService } from './console/service';
import { createSshPool } from './ssh/transport/pool';
import { createPasswordStore } from './ssh/profiles/password-store';
import { createServerTargets, serverHostConfig } from './ssh/profiles/targets';
import { createServerProfiles } from './ssh/profiles/profiles';
import { createHostTrust } from './ssh/profiles/host-trust';
import { registerSshConsoleRoutes } from './http/ssh-console.routes';
import { registerSshRoutes } from './http/ssh.routes';
import { registerSshTargetRoutes } from './http/ssh-targets.routes';
import { registerHostTrustRoutes } from './http/ssh-host-trust.routes';
import { migrateData } from './migrate';

definePlugin({
  async initialize(context) {
    await migrateData(context.hostDataDir, context.dataDir);
    const targets = createServerTargets({ configDir: context.dataDir });
    const pool = createSshPool({
      passwordStore: createPasswordStore({ configDir: context.dataDir }),
      lookupHost: async (alias) => {
        const target = await targets.get(alias);
        return target ? serverHostConfig(target) : undefined;
      },
    });
    const service = createSshConsoleService({ pool, isEnabled: () => true });
    const profiles = createServerProfiles({ targets, pool });
    const app = Fastify({ logger: false });
    registerSshConsoleRoutes(app, service);
    registerSshRoutes(app, { pool, profiles });
    registerSshTargetRoutes(app, profiles);
    registerHostTrustRoutes(app, createHostTrust({ pool }));
    await app.ready();
    return { app, pool, service };
  },
  async request({ app }, input, signal) {
    const response = await app.inject({
      signal,
      method: input.method,
      url: input.url,
      ...(input.body === undefined
        ? {}
        : { payload: JSON.stringify(input.body), headers: { 'content-type': 'application/json' } }),
    });
    return { status: response.statusCode, body: response.body ? response.json() : null };
  },
  async dispose({ app, pool, service }) {
    service.dispose();
    pool.dispose();
    await app.close();
  },
});
