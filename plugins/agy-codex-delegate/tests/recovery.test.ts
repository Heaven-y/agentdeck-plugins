// @vitest-environment jsdom
import { mkdtemp, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import type { PluginApi, SessionContext } from '../../../sdk/browser';
import type { Installation } from '../src/server/install';
import { Engine } from '../src/runtime/engine';
import { createCodexNative } from '../src/native/codex';
import { RpcFailure, type Rpc } from '../src/native/rpc';
import type { NativeFactory, Task } from '../src/runtime/types';

const template = (cwd: string): Task => ({
  id: 'bcae22e2-4f3a-45b2-9126-cb6f2b5b6aca',
  owner: '06da89e4-a498-48cc-b588-c7bfad64bb8b',
  grant: 'grant',
  requestId: 'request',
  inputHash: 'hash',
  title: '返修',
  cwd,
  phase: 'queued',
  round: 2,
  revision: 3,
  config: {},
  updatedAt: Date.now(),
  threadId: '4cdcda93-f088-4c0e-8fb1-f65a138ce915',
});
it('返修尚无本轮标识时重启不能把上一轮完成当成本轮完成', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'delegate-recovery-'));
  const task = template(cwd);
  await writeFile(
    path.join(cwd, 'state.json'),
    JSON.stringify({ schema: 1, enabled: true, config: {}, grants: [], tasks: [task] }),
  );
  let reads = 0;
  const native: NativeFactory = {
    read: async () => {
      reads++;
      return { phase: 'completed', result: '旧轮结果' };
    },
    run: () => {
      throw new Error('恢复不能重开任务');
    },
    remove: async () => {},
    defaults: async () => ({}),
  };
  const engine = new Engine(cwd, native);
  await engine.open();
  expect(reads).toBe(0);
  expect(engine.list()[0]).toMatchObject({ phase: 'interrupted', round: 2 });
});
it('删除阶段重试只接受原生明确不存在，权限或存储错误不能当作已删除', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'delegate-delete-'));
  const task = { ...template(cwd), deleting: true };
  let failure = new RpcFailure(-32600, `thread not found: ${task.threadId}`);
  const native = createCodexNative(
    () =>
      ({
        initialize: async () => {},
        close: async () => {},
        call: async () => {
          throw failure;
        },
      }) as unknown as Rpc,
  );
  await expect(native.remove(task)).resolves.toBeUndefined();
  failure = new RpcFailure(-32603, 'storage failure');
  await expect(native.remove(task)).rejects.toBe(failure);
});

it('删除会话时按实际目录核对归属，接受目录别名并拒绝其他目录', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'delegate-directory-'));
  const alias = `${cwd}-alias`;
  await symlink(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const task = template(await realpath(cwd));
  const request = vi.fn(async (_directory: string, method: string) => (method === 'list' ? [task] : undefined));
  let handler: (state: Installation, input: unknown, signal: AbortSignal) => Promise<{ status: number }>;
  vi.doMock('../../../sdk/backend.mjs', () => ({
    definePlugin: (definition: { request: typeof handler }) => {
      handler = definition.request;
    },
  }));
  vi.doMock('../src/runtime/transport', () => ({ request, ensureRuntime: async () => {} }));
  vi.doMock('../src/server/install', () => ({}));
  try {
    const { startBackend } = await import('../src/server/backend');
    startBackend('unused');
    const remove = (directory: string) =>
      handler!(
        { directory: cwd } as Installation,
        {
          method: 'POST',
          url: '/_agentdeck/lifecycle',
          body: { event: 'session.deleting', session: { agent: 'antigravity', sessionId: task.owner, cwd: directory } },
        },
        new AbortController().signal,
      );
    expect(JSON.parse(JSON.stringify(await remove(alias)))).toEqual({ status: 200, body: {} });
    expect(request).toHaveBeenCalledWith(cwd, 'remove-owner', { owner: task.owner }, expect.any(Object));
    request.mockClear();
    expect((await remove(tmpdir())).status).toBe(400);
    expect(request.mock.calls.map((call) => call[1])).toEqual(['list']);
  } finally {
    await unlink(alias);
    vi.doUnmock('../../../sdk/backend.mjs');
    vi.doUnmock('../src/runtime/transport');
    vi.doUnmock('../src/server/install');
  }
});

it('已读取但未验收的完成结果，关闭重开后自动接续一次，待答问题不重复催问', async () => {
  vi.useFakeTimers();
  try {
    document.body.innerHTML = await readFile(path.resolve('plugins/agy-codex-delegate/index.html'), 'utf8');
    const task: Task = {
      ...template(tmpdir()),
      phase: 'completed',
      notificationId: crypto.randomUUID(),
      deliveredRevision: 3,
    };
    const session: SessionContext = {
      conversationId: crypto.randomUUID(),
      openId: crypto.randomUUID(),
      sessionId: task.owner,
      agent: 'antigravity',
      running: false,
    };
    let sessions: SessionContext[] = [];
    const resume = vi.fn(async () => ({ accepted: true }));
    const api = {
      backend: {
        request: async ({ url }: { url: string }) => ({
          status: 200,
          body:
            url === '/tasks'
              ? [task]
              : url === '/settings'
                ? { config: {}, installed: true, permission: { allowed: true } }
                : {},
        }),
      },
      session: { list: async () => sessions, resume },
      onContext: () => () => {},
      onEvent: () => () => {},
      onCommand: () => () => {},
    } as unknown as PluginApi;
    Object.defineProperty(window, 'agentdeck', { configurable: true, value: api });
    await import('../src/web/main');
    await vi.advanceTimersByTimeAsync(1);
    sessions = [session];
    await vi.advanceTimersByTimeAsync(5000);
    expect(resume).toHaveBeenCalledOnce();
    const firstRequest = resume.mock.calls[0];
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resume).toHaveBeenCalledOnce();
    // 关闭后立即重开，轮询没有机会观察到空列表。
    session.openId = crypto.randomUUID();
    await vi.advanceTimersByTimeAsync(5000);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume.mock.calls[1]).not.toEqual(firstRequest);
    sessions = [];
    await vi.advanceTimersByTimeAsync(5000);
    task.phase = 'waiting';
    session.openId = crypto.randomUUID();
    sessions = [session];
    await vi.advanceTimersByTimeAsync(5000);
    expect(resume).toHaveBeenCalledTimes(2);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
