import { createHash, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { Binding, State } from './types';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** 仅保存身份、配置和执行位置；任务正文留在 CLI 原生会话。 */
export class Store {
  state: State = { schema: 1, enabled: false, config: {}, grants: [], tasks: [] };
  private key = '';
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly directory: string) {}
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const keyFile = path.join(this.directory, 'runtime.key');
    try {
      await writeFile(keyFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    this.key = await readFile(keyFile, 'utf8');
    try {
      const state = JSON.parse(await readFile(path.join(this.directory, 'state.json'), 'utf8')) as State;
      if (state.schema !== 1 || !Array.isArray(state.tasks) || !Array.isArray(state.grants))
        throw new Error('委派记录格式无效');
      this.state = state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  save(): Promise<void> {
    const content = JSON.stringify(this.state);
    const write = this.writes.then(async () => {
      const file = path.join(this.directory, 'state.json');
      await writeFile(`${file}.next`, content, { mode: 0o600 });
      await rename(`${file}.next`, file);
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
  sign(binding: Binding): string {
    const data = Buffer.from(JSON.stringify(binding)).toString('base64url');
    return `${data}.${createHmac('sha256', this.key).update(data).digest('base64url')}`;
  }
  verify(token: string): Binding {
    const [data, signature] = token.split('.');
    if (!data || !signature) throw new Error('委派调用缺少原生会话来源');
    const actual = Buffer.from(signature, 'base64url');
    const expected = createHmac('sha256', this.key).update(data).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('委派会话来源无效');
    const binding = JSON.parse(Buffer.from(data, 'base64url').toString()) as Binding;
    if (Date.now() - binding.issuedAt > 5 * 60_000) throw new Error('委派调用已过期，请重新调用');
    return binding;
  }
}
