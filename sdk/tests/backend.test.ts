import { afterEach, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, readdir, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
it('SDK 在初始化期间调用宿主服务，取消传到业务，断连只清理一次', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-sdk-'));
  cleanups.push(async () => {
    for (const name of await readdir(root)) await unlink(path.join(root, name));
    await rmdir(root);
  });
  const entry = path.join(root, 'entry.mjs');
  await writeFile(
    entry,
    `import {definePlugin} from ${JSON.stringify(new URL('../backend.mjs', import.meta.url).href)};
import {writeFile} from 'node:fs/promises';
definePlugin({
 async initialize(context){const projects=await context.host.request({method:'projects.list'});return {...context,projects};},
 async request(state,input,signal){if(input.url==='/wait')await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return {status:200,body:{projects:state.projects,canceled:signal.aborted}};},
 async dispose(state){await writeFile(state.dataDir+'/disposed','yes');}
});`,
  );
  const child = fork(entry, [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
  });
  let next = 0;
  const pending = new Map<string, (value: unknown) => void>();
  const hostCalls: unknown[] = [];
  child.on('message', (message: { type?: string; id: string; input?: unknown; ok?: boolean; value?: unknown }) => {
    if (message.type === 'host.request') {
      hostCalls.push(message.input);
      child.send({ type: 'host.response', id: message.id, ok: true, value: [{ id: 'project' }] });
    } else if (message.ok) {
      pending.get(message.id)?.(message.value);
      pending.delete(message.id);
    }
  });
  const call = (type: string, input: unknown) => {
    const id = String(++next);
    const result = new Promise((resolve) => pending.set(id, resolve));
    child.send({ id, type, input });
    return { id, result };
  };
  await call('initialize', { dataDir: root, hostDataDir: root }).result;
  expect(hostCalls).toEqual([{ method: 'projects.list' }]);
  const waiting = call('request', { method: 'GET', url: '/wait' });
  child.send({ id: waiting.id, type: 'cancel', input: null });
  expect(await waiting.result).toEqual({ status: 200, body: { projects: [{ id: 'project' }], canceled: true } });
  const exited = once(child, 'exit');
  await call('dispose', null).result;
  await exited;
  expect(await readFile(path.join(root, 'disposed'), 'utf8')).toBe('yes');
});
