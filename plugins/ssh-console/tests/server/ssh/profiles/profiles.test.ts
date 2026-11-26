import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerTargets } from '../../../../src/server/ssh/profiles/targets';
import { createServerProfiles } from '../../../../src/server/ssh/profiles/profiles';
import { registerSshTargetRoutes } from '../../../../src/server/http/ssh-targets.routes';
import { registerSshRoutes } from '../../../../src/server/http/ssh.routes';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});
const input = { name: '演示', hostname: 'example.invalid', username: 'demo', authMode: 'password' as const, port: 22 };
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'profiles-test-'));
  const targets = createServerTargets({ configDir: root, homeDir: root });
  const state = { connected: true, hasPassword: true, saved: false, savingAvailable: false, paused: false };
  const pool = {
    disconnect: vi.fn(),
    forgetServerCredentials: vi.fn(async (_server: unknown) => undefined),
    generation: () => 1,
    credentialStatus: vi.fn(async () => state),
    connect: vi.fn(async () => ({ ...state, connected: true as const, authMode: 'password' as const })),
    clearSavedPassword: vi.fn(async () => ({ ...state, connected: false, hasPassword: false, paused: true })),
    readServerPassword: vi.fn(async () => ({ password: null, revision: 'a'.repeat(64), savingAvailable: false })),
    commitServerEdit: vi.fn(async () => undefined),
  };
  const profiles = createServerProfiles({ targets, pool });
  const app = Fastify();
  registerSshTargetRoutes(app, profiles);
  registerSshRoutes(app, { profiles, pool });
  closers.push(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const server = await targets.save(input);
  return { root, targets, profiles, pool, server, app };
}
describe('服务器档案事务及HTTP保护', () => {
  it('GET只列登记档案，导入选项保留unsupported和私钥路径且不改写config', async () => {
    const f = await fixture();
    await mkdir(path.join(f.root, '.ssh'));
    const file = path.join(f.root, '.ssh', 'config');
    const text = 'Host import-only\n HostName import.invalid\n User demo\n IdentityFile ~/.ssh/demo\n ProxyJump jump\n';
    await writeFile(file, text, 'utf8');
    expect((await f.app.inject({ url: '/api/ssh-targets' })).json()).toEqual([f.server]);
    expect((await f.app.inject({ url: '/api/ssh-targets/import-options' })).json()).toMatchObject([
      { alias: 'import-only', keyFile: path.join(f.root, '.ssh', 'demo'), unsupported: ['ProxyJump'] },
    ]);
    expect(await readFile(file, 'utf8')).toBe(text);
  });
  it('认证变更失效连接，旧快照 409', async () => {
    const f = await fixture();
    const url = '/api/ssh-targets/' + f.server.alias;
    expect(f.pool.disconnect).not.toHaveBeenCalled();
    const next = await f.app.inject({
      method: 'PUT',
      url,
      payload: { input: { ...input, authMode: 'key' }, expected: f.server },
    });
    expect(next.statusCode).toBe(200);
    expect(next.json()).toMatchObject({ alias: f.server.alias, authMode: 'key' });
    expect(f.pool.disconnect).toHaveBeenCalledWith(f.server.alias);
    // 用旧 expected 再改一次必须是 409，不能静默覆盖别人的提交。
    expect((await f.app.inject({ method: 'PUT', url, payload: { input, expected: f.server } })).statusCode).toBe(409);
  });
  it('删除要求完整expected和确认，不静默覆盖档案', async () => {
    const f = await fixture();
    const url = '/api/ssh-targets/' + f.server.alias;
    expect((await f.app.inject({ method: 'DELETE', url, payload: { expected: f.server } })).statusCode).toBe(400);
    expect(
      (await f.app.inject({ method: 'DELETE', url, payload: { expected: f.server, confirmed: true } })).statusCode,
    ).toBe(204);
    expect(await f.targets.list()).toEqual([]);
    expect(f.pool.forgetServerCredentials).toHaveBeenCalledExactlyOnceWith(f.server);
  });
  it('项目存在与否不影响改连接目标', async () => {
    // 旧版本会因"服务器被项目引用"拒绝改 hostname；现在项目里根本没有这个字段。
    const f = await fixture();
    const projectDir = path.join(f.root, 'project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(f.root, 'workspaces.json'),
      JSON.stringify([{ id: 'w1', name: '项目', dir: projectDir }]),
      'utf8',
    );
    const next = await f.app.inject({
      method: 'PUT',
      url: '/api/ssh-targets/' + f.server.alias,
      payload: { input: { ...input, hostname: 'other.invalid' }, expected: f.server },
    });
    expect(next.statusCode).toBe(200);
    expect(next.json()).toMatchObject({ hostname: 'other.invalid' });
  });
  it('连接检查放行普通请求，服务器不存在时报缺失', async () => {
    const f = await fixture();
    const request = (password?: string) =>
      f.app.inject({ method: 'POST', url: '/api/ssh/connect', payload: { sshHost: f.server.alias, password } });
    expect((await request()).statusCode).toBe(200);
    expect((await request('fixture-secret')).statusCode).toBe(200);
    expect(f.pool.connect).toHaveBeenCalledTimes(2);
    expect(f.pool.disconnect).not.toHaveBeenCalled();
    const missing = await f.app.inject({ method: 'POST', url: '/api/ssh/connect', payload: { sshHost: 'gone' } });
    expect(missing.json()).toMatchObject({ code: 'target_missing' });
  });
});

it('HTTP expected按原始完整记录比较，不用默认值或规范化补齐快照', async () => {
  const f = await fixture();
  const { port: _port, ...incomplete } = f.server;
  for (const expected of [incomplete, { ...f.server, hostname: 'EXAMPLE.INVALID' }]) {
    const response = await f.app.inject({
      method: 'PUT',
      url: '/api/ssh-targets/' + f.server.alias,
      payload: { input, expected },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'target_changed' });
  }
  expect(await f.targets.get(f.server.alias)).toEqual(f.server);
  expect(f.pool.disconnect).not.toHaveBeenCalled();
});

it('删除时凭据清理失败保留档案；陈旧快照不触碰凭据', async () => {
  const f = await fixture();
  f.pool.forgetServerCredentials.mockRejectedValueOnce(new Error('清理失败'));
  await expect(f.profiles.remove(f.server.alias, f.server)).rejects.toThrow('清理失败');
  expect(await f.targets.get(f.server.alias)).toEqual(f.server);
  await expect(f.profiles.remove(f.server.alias, { ...f.server, name: '陈旧' })).rejects.toMatchObject({
    code: 'target_changed',
  });
  expect(f.pool.forgetServerCredentials).toHaveBeenCalledTimes(1);
});
