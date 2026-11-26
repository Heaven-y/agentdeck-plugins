import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Engine } from '../runtime/engine';
import { codex } from '../native/codex';
import { ensureRuntime, serve } from '../runtime/transport';
import { handleHook } from '../native/hooks';
import { serveMcp } from './mcp';
import { startBackend } from './backend';
import { watchRemovedOwners } from '../native/owners';

const argument = (name: string) => process.argv[process.argv.indexOf(name) + 1];
async function dataDirectory() {
  if (process.argv.includes('--data-dir')) return path.resolve(argument('--data-dir')!);
  return JSON.parse(await readFile(path.join(path.dirname(process.argv[1]!), 'runtime.json'), 'utf8'))
    .directory as string;
}
async function stdin() {
  let content = '';
  for await (const chunk of process.stdin) {
    content += chunk.toString();
    if (content.length > 128_000) throw new Error('原生 Hook 输入超过限制');
  }
  return JSON.parse(content);
}

async function daemon(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, 'runtime.lock');
  let handle;
  try {
    handle = await open(lock, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const previous = JSON.parse(await readFile(lock, 'utf8')) as { pid: number };
    try {
      process.kill(previous.pid, 0);
      return;
    } catch (problem) {
      if ((problem as NodeJS.ErrnoException).code !== 'ESRCH') return;
    }
    await unlink(lock);
    handle = await open(lock, 'wx', 0o600);
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid }));
  await handle.close();
  try {
    const engine = new Engine(directory, codex);
    await engine.open();
    const server = await serve(engine);
    if (!server) return;
    watchRemovedOwners(engine);
  } catch (error) {
    await unlink(lock).catch(() => undefined);
    throw error;
  }
}

async function main() {
  if (process.argv.includes('--daemon')) return daemon(await dataDirectory());
  if (process.argv.includes('--mcp') || process.argv.includes('--hook')) {
    const directory = await dataDirectory();
    if (process.argv.includes('--mcp')) {
      await ensureRuntime(directory, process.argv[1]!);
      return serveMcp(directory);
    }
    const event = argument('--hook')!;
    const input = await stdin();
    try {
      await ensureRuntime(directory, process.argv[1]!);
      process.stdout.write(`${JSON.stringify(await handleHook(directory, event, input))}\n`);
    } catch {
      const explicit = /^\/(?:agy-codex-delegate:)?with-codex(?:\s|$)/.test(input.lastUserInput ?? '');
      const ownTool =
        /^mcp_(?:agy-codex-delegate_)?codex_delegate_/.test(input.toolCall?.name ?? '') ||
        ['codex_delegate', 'agy-codex-delegate_codex_delegate'].includes(input.toolCall?.args?.ServerName);
      const failure =
        event === 'PreToolUse' && ownTool
          ? { decision: 'deny', reason: '无法核对委派授权，请在委派插件设置中重新连接' }
          : event === 'PreInvocation' && explicit
            ? {
                terminationBehavior: 'terminate',
                injectSteps: [{ errorMessage: { userMessage: '委派接入未就绪，请在插件设置中重新连接' } }],
              }
            : {};
      process.stdout.write(`${JSON.stringify(failure)}\n`);
    }
    return;
  }
  startBackend(process.argv[1]!);
}

void main().catch(() => {
  process.stderr.write('委派运行端启动失败\n');
  process.exitCode = 1;
});
