import { connect, createServer, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from './store';
import type { Engine } from './engine';
import { invoke } from './tools';

const endpoint = (directory: string) => {
  const id = digest(path.resolve(directory)).slice(0, 32);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\agentdeck-delegate-${id}`
    : path.join(tmpdir(), `agentdeck-delegate-${id}.sock`);
};
type Request = { secret: string; method: string; params: Record<string, any> };
type Response = { ok: boolean; value?: any; error?: string };

export async function request(
  directory: string,
  method: string,
  params: Record<string, unknown> = {},
  options: { signal?: AbortSignal; timeout?: number } = {},
): Promise<any> {
  const secret = await readFile(path.join(directory, 'runtime.key'), 'utf8');
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint(directory));
    let buffer = '';
    const finish = (error?: Error, result?: any) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(new Error('委派读取已取消，任务继续运行'));
    const timer = setTimeout(
      () => finish(new Error('委派执行端未确认请求，请先读取原任务')),
      options.timeout ?? 135_000,
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    socket.once('connect', () => socket.write(`${JSON.stringify({ secret, method, params })}\n`));
    socket.once('error', (error) => finish(error));
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024) return finish(new Error('委派结果超过读取限制'));
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const result = JSON.parse(buffer.slice(0, end)) as Response;
        finish(result.ok ? undefined : new Error(result.error ?? '委派请求失败'), result.value);
      } catch {
        finish(new Error('委派执行端返回无效数据'));
      }
    });
  });
}

/** 执行端独立于工作台和 AGY 进程；客户端退出只断开读取。 */
export async function ensureRuntime(directory: string, entry: string) {
  try {
    await request(directory, 'ping', {}, { timeout: 600 });
    return;
  } catch {
    /* 只启动执行端，不重放任务。 */
  }
  const child = spawn(process.execPath, [entry, '--daemon', '--data-dir', directory], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  let failure: Error | undefined;
  child.once('error', (error) => {
    failure = error;
  });
  child.unref();
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    if (failure) throw new Error('无法启动委派执行端');
    try {
      await request(directory, 'ping', {}, { timeout: 500 });
      return;
    } catch {
      /* 等待自身启动，不发送模型任务。 */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('委派执行端未启动，请检查本机运行环境');
}

async function dispatch(engine: Engine, message: Request, signal: AbortSignal) {
  const value = message.params;
  switch (message.method) {
    case 'ping':
      return { protocol: 1 };
    case 'bind':
      return engine.bind(value);
    case 'configure':
      return engine.configure(value);
    case 'settings':
      return { enabled: engine.store.state.enabled, config: engine.store.state.config };
    case 'list':
      return engine.list(typeof value.owner === 'string' ? value.owner : undefined);
    case 'automatic-input':
      return engine.automaticInput(String(value.owner), String(value.text));
    case 'defaults':
      return engine.defaults(String(value.cwd));
    case 'remove-owner':
      return engine.removeOwner(String(value.owner));
    case 'invoke':
      return invoke(engine, value.name, value.arguments, {
        nativeOwner: value.owner,
        signal,
        environment: value.environment,
      });
    default:
      throw new Error('未知委派操作');
  }
}

export async function serve(engine: Engine) {
  const secret = await readFile(path.join(engine.store.directory, 'runtime.key'), 'utf8');
  const handle = (socket: Socket) => {
    let buffer = '';
    let received = false;
    const controller = new AbortController();
    socket.setEncoding('utf8');
    socket.on('error', () => controller.abort());
    socket.on('close', () => controller.abort());
    socket.on('data', (chunk: string) => {
      if (received) return;
      buffer += chunk;
      if (buffer.length > 128_000) return socket.destroy();
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      received = true;
      void (async () => {
        try {
          const message = JSON.parse(buffer.slice(0, end)) as Request;
          if (message.secret !== secret || !message.params || typeof message.params !== 'object')
            throw new Error('委派连接来源无效');
          if (message.method === 'shutdown') {
            if (!engine.canShutdown()) throw new Error('委派任务仍在执行或等待答复，请先结束任务再更新插件');
            socket.end(`${JSON.stringify({ ok: true, value: {} })}\n`, () => {
              process.exit(0);
            });
            return;
          }
          const result = await dispatch(engine, message, controller.signal);
          socket.end(`${JSON.stringify({ ok: true, value: result })}\n`);
        } catch (error) {
          socket.end(
            `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : '委派操作失败' })}\n`,
          );
        }
      })();
    });
    socket.setTimeout(140_000, () => socket.destroy());
  };
  const server = createServer(handle);
  if (process.platform !== 'win32') {
    try {
      await request(engine.store.directory, 'ping', {}, { timeout: 500 });
      return;
    } catch {
      await unlink(endpoint(engine.store.directory)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint(engine.store.directory), resolve);
  });
  return server;
}
