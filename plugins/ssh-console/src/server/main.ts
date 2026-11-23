import Fastify from 'fastify';
import { z } from 'zod';
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

const Initialize = z.strictObject({ dataDir: z.string(), hostDataDir: z.string() });
const Request = z.strictObject({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  url: z.string().regex(/^\/(?!\/)/),
  body: z.json().optional(),
});
const requests = new Map<string, AbortController>();
let close: (() => Promise<void>) | undefined;
let app: ReturnType<typeof Fastify> | undefined;
const reply = (id: string, value: unknown) =>
  new Promise<void>((resolve) => process.send?.({ id, ok: true, value }, () => resolve()));
async function dispose() {
  for (const controller of requests.values()) controller.abort();
  const action = close;
  close = undefined;
  await action?.();
}
process.on('message', async (raw: unknown) => {
  const message = z
    .object({ id: z.string(), type: z.enum(['initialize', 'request', 'dispose', 'cancel']), input: z.unknown() })
    .safeParse(raw);
  if (!message.success) return;
  const { id, type, input } = message.data;
  try {
    if (type === 'cancel') {
      requests.get(id)?.abort();
      return;
    }
    if (type === 'initialize') {
      if (app) throw new Error();
      const context = Initialize.parse(input);
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
      app = Fastify({ logger: false });
      registerSshConsoleRoutes(app, service);
      registerSshRoutes(app, { pool, profiles });
      registerSshTargetRoutes(app, profiles);
      registerHostTrustRoutes(app, createHostTrust({ pool }));
      close = async () => {
        service.dispose();
        pool.dispose();
        await app?.close();
      };
      await app.ready();
      await reply(id, null);
    } else if (type === 'request') {
      if (!app || !close) throw new Error();
      const request = Request.parse(input);
      const controller = new AbortController();
      requests.set(id, controller);
      const response = await app.inject({
        signal: controller.signal,
        method: request.method,
        url: request.url,
        ...(request.body === undefined
          ? {}
          : { payload: JSON.stringify(request.body), headers: { 'content-type': 'application/json' } }),
      });
      requests.delete(id);
      await reply(id, { status: response.statusCode, body: response.body ? response.json() : null });
    } else {
      await dispose();
      await reply(id, null);
      process.disconnect?.();
    }
  } catch {
    requests.delete(id);
    process.send?.({ id, ok: false });
  }
});
process.on('disconnect', () => {
  void dispose().finally(() => process.exit(0));
});
