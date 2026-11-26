import { definePlugin } from '../../../../sdk/backend.mjs';
import { ensureRuntime, request } from '../runtime/transport';
import { prepare, install, nativeEnabled, saveInstallation, type Installation } from './install';
import { permissionStatus, allowDelegation, removeDelegationRule } from '../native/permissions';
import { z } from 'zod';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { SettingsSchema, type Task } from '../runtime/types';

export function startBackend(entry: string) {
  definePlugin({
    async initialize(context) {
      const state = await prepare(context.dataDir, entry);
      await ensureRuntime(state.directory, state.entry);
      if (state.installed && context.enabled !== false) {
        if (state.needsUpdate) await install(state);
        await nativeEnabled(state, true);
        await request(state.directory, 'configure', { enabled: true });
      }
      return state;
    },
    async request(state, input, signal) {
      try {
        const body = await backendRequest(state, input, signal);
        return { status: 200, body };
      } catch (error) {
        return { status: 400, body: { message: error instanceof Error ? error.message : '委派操作失败' } };
      }
    },
  });
}

async function backendRequest(
  state: Installation,
  input: { method: string; url: string; body?: unknown },
  signal: AbortSignal,
) {
  const call = (method: string, params: Record<string, unknown> = {}) =>
    request(state.directory, method, params, { signal, timeout: 35_000 });
  if (input.url === '/_agentdeck/lifecycle' && input.method === 'POST') {
    const event = z
      .object({
        event: z.string(),
        session: z.object({ agent: z.string(), sessionId: z.string(), cwd: z.string() }).optional(),
      })
      .parse(input.body);
    if (event.event === 'session.deleting') {
      if (event.session?.agent !== 'antigravity') return {};
      const tasks: Task[] = await call('list', { owner: event.session.sessionId });
      const cwd = tasks.length ? await realpath(event.session.cwd) : event.session.cwd;
      if (tasks.some((task) => path.resolve(task.cwd) !== cwd)) throw new Error('关联任务目录不一致，会话保留');
      await call('remove-owner', { owner: event.session.sessionId });
      return {};
    }
    if (event.event === 'update') {
      await call('shutdown');
      return {};
    }
    await call('configure', { enabled: false });
    await nativeEnabled(state, false);
    if (event.event === 'uninstall' && state.permissionAdded) {
      await removeDelegationRule();
      state.permissionAdded = false;
      await saveInstallation(state);
    }
    return {};
  }
  if (input.url === '/settings' && input.method === 'GET')
    return { ...(await call('settings')), installed: state.installed, permission: await permissionStatus() };
  if (input.url === '/settings' && input.method === 'PUT')
    return call('configure', { config: SettingsSchema.parse(input.body) });
  if (input.url === '/tasks' && input.method === 'GET') return call('list');
  if (input.url === '/automatic-input' && input.method === 'POST')
    return call(
      'automatic-input',
      z.object({ owner: z.string().uuid(), text: z.string().min(1).max(1000) }).parse(input.body),
    );
  if (input.url === '/install' && input.method === 'POST') {
    z.strictObject({ allowDelegation: z.literal(true) }).parse(input.body);
    state.permissionAdded = (await allowDelegation()) || state.permissionAdded;
    await saveInstallation(state);
    await install(state);
    await nativeEnabled(state, true);
    await call('configure', { enabled: true });
    return { installed: true };
  }
  if (input.url === '/defaults' && input.method === 'POST') {
    const value = z.object({ cwd: z.string().min(1).optional() }).parse(input.body ?? {});
    return call('defaults', { cwd: value.cwd ?? homedir() });
  }
  throw new Error('未知委派页面操作');
}
