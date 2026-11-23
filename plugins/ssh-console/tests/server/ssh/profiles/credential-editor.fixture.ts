import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { createPasswordStore } from '../../../../src/server/ssh/profiles/password-store';
import { createSshPool } from '../../../../src/server/ssh/transport/pool';
import { createServerTargets, serverHostConfig } from '../../../../src/server/ssh/profiles/targets';
import { createServerProfiles } from '../../../../src/server/ssh/profiles/profiles';
import { registerSshTargetRoutes } from '../../../../src/server/http/ssh-targets.routes';
import { registerSshRoutes } from '../../../../src/server/http/ssh.routes';
import type { SecretProtector } from '../../../../src/server/platform/secrets/windows-protection';
import type { ManagedServer } from '../../../../src/shared/index';

export const input = {
  name: '合成服务器',
  hostname: 'example.invalid',
  username: 'demo',
  port: 22,
  authMode: 'password' as const,
};
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
// 仅使用本测试生成的密钥、密文和目标；不访问真实 DPAPI 文件或 SSH 配置。
function encryptedFixture(): SecretProtector {
  const key = randomBytes(32);
  return {
    available: true,
    async protect(data, entropy) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(entropy);
      const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    async unprotect(data, entropy) {
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAAD(entropy);
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]);
    },
  };
}
export async function credentialEditorFixture() {
  const root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'docked-credentials-fixture-'));
  const targets = createServerTargets({ configDir: root, homeDir: root });
  const server = await targets.save(input);
  const protector = encryptedFixture();
  const passwords = createPasswordStore({ configDir: root, protector });
  const pool = createSshPool({
    homeDir: root,
    passwordStore: passwords,
    readFile: async () => Buffer.alloc(0),
    lookupHost: async (alias) => {
      const current = await targets.get(alias);
      return current ? serverHostConfig(current) : undefined;
    },
  });
  const profiles = createServerProfiles({ targets, pool });
  const app = Fastify();
  const origin = 'http://localhost:43210';
  registerSshTargetRoutes(app, profiles);
  registerSshRoutes(app, { profiles, pool });
  const headers = { cookie: '' };
  const read = (expected: ManagedServer = server) =>
    app.inject({
      method: 'POST',
      url: `/api/ssh-targets/${expected.alias}/password/read`,
      headers,
      payload: { expected },
    });
  const edit = (
    revision: string,
    fields: { expected?: ManagedServer; input?: typeof input; password?: string | null } = {},
  ) => {
    const expected = fields.expected ?? server;
    return app.inject({
      method: 'PUT',
      url: `/api/ssh-targets/${expected.alias}/password`,
      headers,
      payload: { input: fields.input ?? input, expected, revision, password: fields.password, confirmed: true },
    });
  };
  return {
    root,
    targets,
    server,
    protector,
    passwords,
    pool,
    profiles,
    app,
    headers,
    read,
    edit,
    async close() {
      pool.dispose();
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
