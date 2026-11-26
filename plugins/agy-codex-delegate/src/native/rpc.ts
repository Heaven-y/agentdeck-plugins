import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

export type ObjectValue = Record<string, any>;
type Pending = { resolve(value: ObjectValue): void; reject(error: Error): void; timer: NodeJS.Timeout };
export class RpcFailure extends Error {
  constructor(
    readonly code: number,
    readonly nativeMessage: string,
  ) {
    super('Codex 拒绝请求，请核对原生版本、配置及任务状态');
  }
}

/** 优先直接运行原生可执行文件，避免 Windows 的 cmd 二次解释用户输入。 */
export function codexExecutable(environment: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command: 'codex', args: [] };
  const dirs = (environment.PATH ?? environment.Path ?? '').split(path.delimiter);
  for (const dir of dirs) {
    const executable = path.join(dir, 'codex.exe');
    if (existsSync(executable)) return { command: executable, args: [] };
    const script = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(script)) {
      const packageRoot = path.dirname(path.dirname(script));
      const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
      const platformPackage = `codex-win32-${process.arch}`;
      const candidates = [
        path.join(packageRoot, 'node_modules', '@openai', platformPackage),
        path.join(dir, 'node_modules', '@openai', platformPackage),
        packageRoot,
      ].map((root) => path.join(root, 'vendor', `${arch}-pc-windows-msvc`, 'bin', 'codex.exe'));
      const binary = candidates.find(existsSync);
      return binary ? { command: binary, args: [] } : { command: process.execPath, args: [script] };
    }
  }
  const require = createRequire(path.resolve('package.json'));
  try {
    return { command: process.execPath, args: [require.resolve('@openai/codex/bin/codex.js')] };
  } catch {
    throw new Error('未找到 Codex CLI，请先安装并配置原生 Codex');
  }
}

export class Rpc {
  readonly exited: Promise<void>;
  notification: (method: string, params: ObjectValue) => void = () => {};
  requestFromServer: (id: number | string, method: string, params: ObjectValue) => void = (id) => this.reject(id);
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private buffer = '';
  private failure?: Error;
  constructor(
    cwd: string,
    executable?: { command: string; args: string[] },
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    const launch = executable ?? codexExecutable(environment);
    this.child = spawn(launch.command, [...launch.args, 'app-server', '--listen', 'stdio://'], {
      cwd,
      env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      stdio: 'pipe',
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (value: string) => this.receive(value));
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.fail(new Error('Codex 连接中断')));
    this.child.on('error', () => this.fail(new Error('无法启动 Codex CLI')));
    this.exited = new Promise((resolve) =>
      this.child.once('close', () => {
        this.fail(new Error('Codex 原生执行进程已退出'));
        resolve();
      }),
    );
  }
  async initialize() {
    await this.call('initialize', {
      clientInfo: { name: 'agentdeck_delegate', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized', params: {} });
  }
  call(method: string, params: ObjectValue): Promise<ObjectValue> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= 64) return Promise.reject(new Error('Codex 请求过多'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} 未确认，请先核对原任务`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  respond(id: number | string, result: unknown) {
    this.write({ id, result });
  }
  reject(id: number | string) {
    this.write({ id, error: { code: -32601, message: '委派执行端不支持此原生请求' } });
  }
  private write(value: unknown) {
    if (this.failure) throw this.failure;
    const data = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(data) > 4 * 1024 * 1024) throw new Error('Codex 请求超过大小限制');
    this.child.stdin.write(data);
  }
  private receive(value: string) {
    this.buffer += value;
    if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) return this.fail(new Error('Codex 返回超过大小限制'));
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        this.dispatch(JSON.parse(line));
      } catch {
        this.fail(new Error('Codex 返回无效的协议消息'));
      }
    }
  }
  private dispatch(message: ObjectValue) {
    if (message.method) {
      if (message.id !== undefined) this.requestFromServer(message.id, message.method, message.params ?? {});
      else this.notification(message.method, message.params ?? {});
      return;
    }
    const item = this.pending.get(message.id);
    if (!item) return;
    this.pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new RpcFailure(message.error.code, String(message.error.message ?? '')));
    else item.resolve(message.result ?? {});
  }
  private fail(error: Error) {
    this.failure ??= error;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
    if (this.child.exitCode === null && !this.child.killed) this.child.kill();
  }
  async close() {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 1500);
    await this.exited;
    clearTimeout(timer);
  }
}
