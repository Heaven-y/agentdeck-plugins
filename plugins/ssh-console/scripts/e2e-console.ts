import Fastify from 'fastify';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startTerminalFixture } from './fixtures/terminal-fixture';
import { createResourceFixture } from './fixtures/resource-fixture';
import { createServerProfiles } from '../src/server/ssh/profiles/profiles';
import { createSshConsoleService } from '../src/server/console/service';
import { registerSshRoutes } from '../src/server/http/ssh.routes';
import { registerSshTargetRoutes } from '../src/server/http/ssh-targets.routes';
import { registerSshConsoleRoutes } from '../src/server/http/ssh-console.routes';
const root = await mkdtemp(path.join(os.tmpdir(), 'ssh-fixture-'));
const fixture = await startTerminalFixture({
  configDir: root,
  workspaceDir: path.join(root, 'workspace'),
  exec: createResourceFixture().exec,
});
const app = Fastify();
const service = createSshConsoleService({ pool: fixture.pool, isEnabled: () => true });
registerSshRoutes(app, {
  pool: fixture.pool,
  profiles: createServerProfiles({ targets: fixture.targets, pool: fixture.pool }),
});
registerSshTargetRoutes(app, createServerProfiles({ targets: fixture.targets, pool: fixture.pool }));
registerSshConsoleRoutes(app, service);
console.log(await app.listen({ host: '127.0.0.1', port: 0 }));
console.log(JSON.stringify({ serverId: (await fixture.targets.list())[0]?.alias }));
const close = async () => {
  service.dispose();
  await fixture.close();
  await app.close();
};
process.once('SIGINT', () => {
  void close();
});
process.once('SIGTERM', () => {
  void close();
});
