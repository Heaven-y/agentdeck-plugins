import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { Store, digest } from './store';
import { userMessageId } from '../native/user-source';
import {
  SettingsSchema,
  TaskInputSchema,
  terminal,
  type Binding,
  type NativeFactory,
  type NativeRun,
  type Settings,
  type Task,
} from './types';

const HookSchema = z.object({
  conversationId: z.string().uuid(),
  workspacePaths: z.array(z.string().min(1)).min(1),
  transcriptPath: z.string().min(1),
  lastUserInput: z.string().default(''),
  invocationNum: z.number().optional(),
  initialNumSteps: z.number().optional(),
  event: z.string().default('PreInvocation'),
});
type Live = { run: NativeRun; round: number; promise: Promise<void> };

/** 任务的创建、归属、续接和状态迁移集中于此；工具及工作台共享同一执行端。 */
export class Engine {
  readonly store: Store;
  private live = new Map<string, Live>();
  private queued = new Map<string, { prompt: string; environment?: NodeJS.ProcessEnv }>();
  private events = new EventEmitter();
  private userHashes = new Map<string, string>();
  private injections = new Map<string, string>();
  private mutations: Promise<unknown> = Promise.resolve();
  private removing = new Map<string, Promise<void>>();
  constructor(
    directory: string,
    private native: NativeFactory,
  ) {
    this.store = new Store(directory);
  }
  async open() {
    await this.store.open();
    for (const task of this.store.state.tasks) {
      if (terminal(task.phase)) continue;
      const observed: Awaited<ReturnType<NativeFactory['read']>> =
        task.threadId && task.turnId ? await this.native.read(task).catch(() => ({})) : {};
      task.phase = observed.phase ?? 'interrupted';
      task.error = task.phase === 'interrupted' ? '执行端已重启；请核对原生会话和已有修改，再续接剩余工作' : undefined;
      task.revision++;
      task.notificationId = randomUUID();
    }
    await this.store.save();
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation);
    this.mutations = result.catch(() => undefined);
    return result;
  }
  async configure(input: { enabled?: boolean; config?: Settings }) {
    return this.serial(async () => {
      if (input.enabled !== undefined) this.store.state.enabled = input.enabled;
      if (input.config !== undefined) this.store.state.config = SettingsSchema.parse(input.config);
      await this.store.save();
      return { enabled: this.store.state.enabled, config: this.store.state.config };
    });
  }
  async bind(raw: unknown) {
    const input = HookSchema.parse(raw);
    const cwd = await realpath(input.workspacePaths[0]!);
    const source = await userMessageId(input.transcriptPath);
    return this.serial(async () => {
      const inputHash = digest(`${input.conversationId}:${source}`);
      const automatic = this.store.state.automaticInputs?.some(
        (item) => item.owner === input.conversationId && item.textHash === digest(input.lastUserInput),
      );
      if (!automatic) this.userHashes.set(input.conversationId, inputHash);
      let grant = this.store.state.grants.findLast((item) => item.owner === input.conversationId && !item.closed);
      const seen = this.store.state.grants.find(
        (item) => item.owner === input.conversationId && item.inputHash === inputHash,
      );
      const explicit = /^\/(?:agy-codex-delegate:)?with-codex(?:\s|$)/.test(input.lastUserInput.trimStart());
      if (explicit && seen) grant = seen.closed ? undefined : seen;
      if (
        explicit &&
        this.store.state.enabled &&
        !seen &&
        !this.store.state.deletingOwners?.includes(input.conversationId)
      ) {
        if (grant) grant.closed = true;
        grant = {
          id: randomUUID(),
          owner: input.conversationId,
          cwd,
          inputHash,
          transcriptPath: input.transcriptPath,
          createdAt: Date.now(),
        };
        this.store.state.grants.push(grant);
        await this.store.save();
      }
      const binding: Binding = {
        owner: input.conversationId,
        cwd,
        issuedAt: Date.now(),
        userHash: automatic ? (this.userHashes.get(input.conversationId) ?? '') : inputHash,
        automatic,
        ...(grant ? { grant: grant.id } : {}),
      };
      const tasks = this.list(binding.owner);
      const key = digest(
        JSON.stringify([
          inputHash,
          binding.grant,
          tasks
            .filter((task) => task.phase === 'waiting' || terminal(task.phase))
            .map((task) => [task.id, task.revision]),
        ]),
      );
      const inject = input.event === 'PreInvocation' && this.injections.get(binding.owner) !== key;
      if (inject) this.injections.set(binding.owner, key);
      return { token: this.store.sign(binding), owner: binding.owner, granted: !!binding.grant, tasks, inject };
    });
  }
  list(owner?: string) {
    return this.store.state.tasks.filter((task) => !owner || task.owner === owner).map((task) => ({ ...task }));
  }
  private task(token: string, id: string) {
    const binding = this.store.verify(token);
    const task = this.store.state.tasks.find((item) => item.id === id);
    if (!task || task.owner !== binding.owner || task.cwd !== binding.cwd) throw new Error('任务不属于当前 AGY 会话');
    return task;
  }
  async start(token: string, raw: unknown, environment?: NodeJS.ProcessEnv) {
    const input = TaskInputSchema.parse(raw);
    return this.serial(async () => {
      const binding = this.store.verify(token);
      if (this.store.state.deletingOwners?.includes(binding.owner))
        throw new Error('所属 AGY 会话正在删除，不能创建任务');
      const grant = this.store.state.grants.find(
        (item) => item.id === binding.grant && item.owner === binding.owner && item.cwd === binding.cwd && !item.closed,
      );
      if (!this.store.state.enabled) throw new Error('委派扩展已停用');
      if (!grant) throw new Error('请先由用户使用 /with-codex 允许本次任务');
      const inputHash = digest(JSON.stringify(input));
      const previous = this.store.state.tasks.find(
        (task) => task.grant === grant.id && task.requestId === input.requestId,
      );
      if (previous) {
        if (previous.inputHash !== inputHash) throw new Error('同一请求的任务内容不一致，请核对原任务');
        return { ...previous };
      }
      if (binding.userHash !== grant.inputHash && grant.dispatchHash && binding.userHash !== grant.dispatchHash)
        throw new Error('后续消息只能续接已有任务；新建委派需再次使用 /with-codex');
      grant.dispatchHash ??= binding.userHash;
      const task: Task = {
        id: randomUUID(),
        owner: binding.owner,
        grant: grant.id,
        requestId: input.requestId,
        inputHash,
        title: input.title,
        cwd: grant.cwd,
        phase: 'queued',
        round: 1,
        revision: 1,
        config: { ...this.store.state.config },
        updatedAt: Date.now(),
        ...(environment?.CODEX_HOME ? { codexHome: environment.CODEX_HOME } : {}),
      };
      this.store.state.tasks.push(task);
      await this.store.save();
      this.queued.set(task.id, { prompt: `${input.instructions}\n\n验收条件：\n${input.acceptance}`, environment });
      this.drain();
      return { ...task };
    });
  }
  private drain() {
    const busy = new Set(
      this.store.state.tasks
        .filter((task) => this.live.has(task.id) || task.phase === 'waiting')
        .map((task) => task.cwd),
    );
    for (const [id, queued] of this.queued) {
      const task = this.store.state.tasks.find((item) => item.id === id);
      if (!task || busy.has(task.cwd)) continue;
      this.queued.delete(id);
      busy.add(task.cwd);
      const run = this.native.run(queued.environment);
      const round = task.round;
      task.phase = 'starting';
      const promise = run
        .start(task, queued.prompt, (value) => this.change(task, round, value))
        .catch((error: unknown) =>
          this.change(task, round, {
            phase: 'interrupted',
            error: error instanceof Error ? error.message : '执行状态尚未确认，请读取原生会话',
          }),
        )
        .finally(() => {
          this.live.delete(id);
          this.drain();
        });
      this.live.set(id, { run, round, promise });
    }
  }
  private async change(task: Task, round: number, patch: Partial<Task>) {
    if (task.round !== round || !this.store.state.tasks.includes(task)) return;
    Object.assign(task, patch, { revision: task.revision + 1, updatedAt: Date.now() });
    if (patch.phase && (terminal(patch.phase) || patch.phase === 'waiting')) task.notificationId = randomUUID();
    if (patch.phase === 'waiting') task.pendingInputHash ??= this.userHashes.get(task.owner);
    else if (patch.phase === 'running') task.pendingInputHash = undefined;
    await this.store.save();
    this.events.emit(task.id);
  }
  async read(token: string, id: string) {
    const task = this.task(token, id);
    const live = this.live.get(id);
    const snapshot = live?.run.snapshot() ?? (task.threadId ? await this.native.read(task) : {});
    return { ...task, ...snapshot, phase: task.phase };
  }
  async wait(token: string, id: string, milliseconds = 25_000, signal?: AbortSignal) {
    const task = this.task(token, id);
    if (!terminal(task.phase) && task.phase !== 'waiting') {
      await new Promise<void>((resolve) => {
        const changed = () => {
          if (terminal(task.phase) || task.phase === 'waiting') finish();
        };
        const finish = () => {
          clearTimeout(timer);
          this.events.off(id, changed);
          signal?.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, Math.min(120_000, Math.max(0, milliseconds)));
        this.events.on(id, changed);
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) finish();
        changed();
      });
    }
    if (terminal(task.phase)) await this.live.get(id)?.promise;
    return this.read(token, id);
  }
  async answer(
    token: string,
    id: string,
    questionId: string | number,
    answer: unknown,
    environment?: NodeJS.ProcessEnv,
  ) {
    const task = this.task(token, id);
    if (task.pendingAsync) {
      if (questionId !== `async:${task.pendingAsync.itemId}` || typeof answer !== 'string' || !answer.trim())
        throw new Error('请答复当前原生问题');
      if (!this.store.state.enabled) throw new Error('请先重新启用委派扩展，待答问题已保留');
      await this.live.get(id)?.promise;
      const requestId = `answer:${task.pendingAsync.itemId}`;
      task.pendingAsync = undefined;
      task.phase = 'interrupted';
      return this.continue(
        token,
        id,
        { requestId, instructions: `对刚才待答问题的答复：\n${answer}\n请核对已有工作，继续原任务。` },
        environment,
      );
    }
    const live = this.live.get(id);
    if (!live) throw new Error('原生问题连接已结束，请先恢复原任务，不能补造批准');
    const question = live.run.snapshot().question;
    if (!question || question.id !== questionId) throw new Error('请先回答当前显示的问题，再读取下一个问题');
    if (question.approval) {
      const source = this.store.verify(token);
      if (source.automatic || !source.userHash || source.userHash === task.pendingInputHash)
        throw new Error('此请求需要用户答复，请先在 AGY 主对话询问用户');
    }
    await live.run.answer(questionId, answer);
    return this.read(token, id);
  }
  async continue(
    token: string,
    id: string,
    raw: { requestId: string; instructions: string },
    environment?: NodeJS.ProcessEnv,
  ) {
    const input = z
      .strictObject({ requestId: z.string().min(1).max(100), instructions: z.string().trim().min(1).max(60_000) })
      .parse(raw);
    if (terminal(this.task(token, id).phase)) await this.live.get(id)?.promise;
    return this.serial(async () => {
      const task = this.task(token, id);
      if (this.store.state.deletingOwners?.includes(task.owner)) throw new Error('所属 AGY 会话正在删除，不能继续任务');
      const requestHash = digest(JSON.stringify(input));
      if (task.continuation?.requestId === input.requestId) {
        if (task.continuation.hash !== requestHash) throw new Error('续接请求内容不一致');
        return { ...task };
      }
      if (!terminal(task.phase) || this.live.has(id)) throw new Error('原任务尚未结束，请先处理待答问题或等待结果');
      if (!this.store.state.enabled) throw new Error('请先重新启用委派扩展');
      task.round++;
      task.phase = 'queued';
      task.accepted = false;
      task.cancelRequested = false;
      task.error = undefined;
      task.turnId = undefined;
      task.continuation = { requestId: input.requestId, hash: requestHash };
      await this.store.save();
      this.queued.set(id, {
        prompt: input.instructions,
        environment: { ...(environment ?? process.env), ...(task.codexHome ? { CODEX_HOME: task.codexHome } : {}) },
      });
      this.drain();
      return { ...task };
    });
  }
  async cancel(token: string, id: string) {
    const task = this.task(token, id);
    if (task.pendingAsync) await this.live.get(id)?.promise;
    if (this.queued.delete(id)) await this.change(task, task.round, { phase: 'cancelled' });
    else if (this.live.has(id)) {
      await this.change(task, task.round, { cancelRequested: true });
      await this.live.get(id)!.run.cancel();
    } else if (task.phase === 'waiting') {
      task.pendingAsync = undefined;
      await this.change(task, task.round, { phase: 'cancelled', cancelRequested: true });
      this.drain();
    }
    return this.read(token, id);
  }
  async acknowledge(token: string, id: string, revision: number, accepted = false) {
    const task = this.task(token, id);
    if (task.revision !== revision) return { acknowledged: false };
    if (accepted && task.phase !== 'completed') throw new Error('任务尚未完成，无法标记验收通过');
    task.deliveredRevision = revision;
    if (accepted && task.phase === 'completed') {
      task.accepted = true;
      if (this.store.state.tasks.filter((item) => item.grant === task.grant).every((item) => item.accepted)) {
        const grant = this.store.state.grants.find((item) => item.id === task.grant);
        if (grant) grant.closed = true;
      }
    }
    await this.store.save();
    return { acknowledged: true };
  }
  async finishScope(token: string) {
    const binding = this.store.verify(token);
    const grant = this.store.state.grants.find((item) => item.id === binding.grant && item.owner === binding.owner);
    if (grant) grant.closed = true;
    await this.store.save();
    return { closed: true };
  }
  async automaticInput(owner: string, text: string) {
    const entries = (this.store.state.automaticInputs ??= []);
    entries.push({ owner, textHash: digest(text) });
    if (entries.length > 1000) entries.splice(0, entries.length - 1000);
    await this.store.save();
    return {};
  }
  canShutdown() {
    return this.live.size === 0 && this.queued.size === 0;
  }
  removeOwner(owner: string): Promise<void> {
    const existing = this.removing.get(owner);
    if (existing) return existing;
    const operation = this.removeOwnerTasks(owner).finally(() => this.removing.delete(owner));
    this.removing.set(owner, operation);
    return operation;
  }
  private async removeOwnerTasks(owner: string) {
    await this.serial(async () => {
      this.store.state.deletingOwners ??= [];
      if (!this.store.state.deletingOwners.includes(owner)) this.store.state.deletingOwners.push(owner);
      for (const grant of this.store.state.grants) if (grant.owner === owner) grant.closed = true;
      for (const task of this.store.state.tasks)
        if (task.owner === owner) {
          this.queued.delete(task.id);
          task.deleting = true;
        }
      await this.store.save();
    });
    const tasks = this.store.state.tasks.filter((item) => item.owner === owner);
    for (const task of tasks) {
      const live = this.live.get(task.id);
      if (live) {
        await live.run.cancel();
        await live.promise;
      }
      await this.native.remove(task);
      this.store.state.tasks = this.store.state.tasks.filter((item) => item.id !== task.id);
      await this.store.save();
    }
    this.store.state.grants = this.store.state.grants.filter((grant) => grant.owner !== owner);
    await this.store.save();
    this.drain();
  }
  async defaults(cwd: string) {
    return this.native.defaults(cwd);
  }
}
