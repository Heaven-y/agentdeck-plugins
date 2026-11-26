import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { nativeGuide } from '../native/hooks';

const execute = promisify(execFile);
export const pluginName = 'agy-codex-delegate';
export type Installation = {
  directory: string;
  entry: string;
  installed: boolean;
  revision: string;
  needsUpdate: boolean;
  permissionAdded?: boolean;
};

export async function prepare(directory: string, entry: string): Promise<Installation> {
  const native = path.join(directory, 'native');
  await mkdir(path.join(native, 'skills', 'with-codex'), { recursive: true });
  const bridge = path.join(native, 'bridge.cjs');
  const revision = createHash('sha256')
    .update(await readFile(entry))
    .digest('hex');
  if (path.resolve(entry) !== path.resolve(bridge)) await copyFile(entry, bridge);
  const json = (file: string, value: unknown) =>
    writeFile(path.join(native, file), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await json('plugin.json', {
    name: pluginName,
    version: '0.1.0',
    displayName: 'Codex 委派',
    description: '在 AGY 中明确分派 Codex、接收问题并验收结果。',
  });
  await json('runtime.json', { directory });
  await json('mcp_config.json', {
    mcpServers: {
      codex_delegate: {
        command: 'node',
        args: ['${PLUGIN_ROOT}/bridge.cjs', '--mcp'],
        timeoutSeconds: 150,
        tools: Object.fromEntries(
          ['start', 'read', 'answer', 'continue', 'cancel', 'accept', 'finish_scope', 'wait'].map((name) => [
            `codex_${name}`,
            { eager: true, ...(name === 'wait' ? { background: 'always' } : {}) },
          ]),
        ),
      },
    },
  });
  const handler = (name: string) => ({ type: 'command', command: `node ./bridge.cjs --hook ${name}`, timeout: 15 });
  await json('hooks.json', {
    'codex-delegation': {
      PreInvocation: [handler('PreInvocation')],
      PreToolUse: [
        { matcher: 'mcp_(agy-codex-delegate_)?codex_delegate_.*|call_mcp_tool', hooks: [handler('PreToolUse')] },
      ],
      Stop: [handler('Stop')],
    },
  });
  await writeFile(path.join(native, 'skills', 'with-codex', 'SKILL.md'), nativeGuide, 'utf8');
  let installed = false;
  let previousRevision: string | undefined;
  let permissionAdded = false;
  try {
    const previous = JSON.parse(await readFile(path.join(directory, 'installation.json'), 'utf8'));
    installed = previous.installed === true;
    previousRevision = previous.revision;
    permissionAdded = previous.permissionAdded === true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {
    directory,
    entry: bridge,
    installed,
    revision,
    needsUpdate: installed && previousRevision !== revision,
    permissionAdded,
  };
}

export async function install(state: Installation) {
  try {
    await execute('agy', ['plugin', 'install', path.dirname(state.entry)], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 512 * 1024,
    });
  } catch {
    throw new Error('AGY 插件安装失败，请确认本机 agy 可运行，并在原生插件列表检查同名插件');
  }
  state.installed = true;
  state.needsUpdate = false;
  await saveInstallation(state);
}
export async function saveInstallation(state: Installation) {
  await writeFile(
    path.join(state.directory, 'installation.json'),
    JSON.stringify({ installed: state.installed, revision: state.revision, permissionAdded: state.permissionAdded }),
    { mode: 0o600 },
  );
}

export async function nativeEnabled(state: Installation, enabled: boolean) {
  if (!state.installed) return;
  try {
    await execute('agy', ['plugin', enabled ? 'enable' : 'disable', pluginName], {
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 256 * 1024,
    });
  } catch {
    throw new Error(`AGY 原生插件未确认${enabled ? '启用' : '停用'}，请在 AGY 的 /plugin 中检查`);
  }
}
