import path from 'node:path';
import { Rpc, RpcFailure, type ObjectValue } from './rpc';
import type { NativeFactory, NativeQuestion, NativeRun, NativeSnapshot, Phase, Task } from '../runtime/types';
import { z } from 'zod';
type RpcFactory = (cwd: string, environment?: NodeJS.ProcessEnv) => Rpc;

const coordinatorTool = {
  type: 'function',
  name: 'ask_manager',
  description:
    '只有缺少必要材料、要求冲突或需要外部决定时，暂停并向负责分派任务的 AGY 提问。普通编译和测试失败应自行排查。',
  inputSchema: {
    type: 'object',
    properties: { question: { type: 'string' } },
    required: ['question'],
    additionalProperties: false,
  },
};
const instructions =
  '你正在执行 AGY 明确委派的任务。保持目标、范围及验收要求；不要读取或同步 AGY 的其他聊天。遇到需外部答复的阻塞时调用 ask_manager 并等待答案；常规命令和测试失败自行诊断。完成后报告实际修改、验证及尚未解决事项，由 AGY 验收。遵守项目规则和既有权限，不改变原生子代理配置。';
const approvals = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);

function resultText(thread: ObjectValue, turnId?: string): string | undefined {
  const turns: ObjectValue[] = thread.turns ?? [];
  const turn = turnId ? turns.find((value) => value.id === turnId) : turns.at(-1);
  const messages: ObjectValue[] = (turn?.items ?? []).filter(
    (item: ObjectValue) => item.type === 'agentMessage' && item.delivery !== 'async',
  );
  return (messages.findLast((item) => item.phase === 'final_answer') ?? messages.at(-1))?.text || undefined;
}
function nativePhase(status: unknown, task?: Task): Phase {
  if (status === 'completed') return 'completed';
  if (status === 'interrupted') return task?.cancelRequested ? 'cancelled' : 'interrupted';
  return 'failed';
}

class CodexRun implements NativeRun {
  constructor(
    private createRpc: RpcFactory,
    private environment?: NodeJS.ProcessEnv,
  ) {}
  private rpc?: Rpc;
  private task?: Task;
  private state: NativeSnapshot = { phase: 'starting' };
  private questions = new Map<string | number, NativeQuestion>();
  private update: (value: Partial<Task>) => Promise<void> = async () => {};
  private resolveDone!: () => void;
  private done = new Promise<void>((resolve) => {
    this.resolveDone = resolve;
  });
  private expectedTurn?: string;
  private finished = false;
  private resolved = new Set<string>();
  private endedTurns = new Set<string>();
  private asyncQuestion?: NativeQuestion;
  private cancelled = false;
  private children = new Map<string, { turnId?: string; active: boolean }>();
  private childChecks = new Map<string, Promise<void>>();
  private rootResult?: ObjectValue;
  private writes: Promise<void> = Promise.resolve();
  private patch(value: Partial<Task>) {
    if (value.phase) this.state.phase = value.phase;
    this.writes = this.writes.then(() => this.update(value));
    void this.writes.catch(() => {
      this.finished = true;
      this.resolveDone();
      void this.rpc?.close();
    });
    return this.writes;
  }
  async start(task: Task, prompt: string, update: (value: Partial<Task>) => Promise<void>) {
    this.task = task;
    this.update = update;
    const rpc = (this.rpc = this.createRpc(task.cwd, this.environment));
    rpc.notification = (method, params) => this.notification(method, params);
    rpc.requestFromServer = (id, method, params) => {
      void this.question(id, method, params).catch(() => rpc.reject(id));
    };
    try {
      await rpc.initialize();
      if (await this.cancelBeforeTurn()) return;
      if (task.threadId) {
        const existing = (await rpc.call('thread/read', { threadId: task.threadId, includeTurns: false })).thread;
        if (existing.id !== task.threadId || path.resolve(existing.cwd) !== path.resolve(task.cwd))
          throw new Error('Codex 会话归属不一致');
      }
      const config = task.config;
      const response = await rpc.call(task.threadId ? 'thread/resume' : 'thread/start', {
        ...(task.threadId
          ? { threadId: task.threadId, excludeTurns: true }
          : { developerInstructions: instructions, dynamicTools: [coordinatorTool] }),
        cwd: task.cwd,
        ...(config.model ? { model: config.model } : {}),
        ...(config.sandbox ? { sandbox: config.sandbox } : {}),
        ...(config.approvalPolicy ? { approvalPolicy: config.approvalPolicy } : {}),
      });
      const threadId = response.thread?.id;
      if (typeof threadId !== 'string') throw new Error('Codex 未返回原生会话标识');
      task.threadId = threadId;
      await this.patch({
        threadId,
        recordPath: response.thread.path,
        actual: {
          model: response.model,
          effort: config.effort ?? response.reasoningEffort,
          approvalPolicy: response.approvalPolicy,
          sandbox: response.sandbox,
        },
      });
      if (await this.cancelBeforeTurn()) return;
      const started = await rpc.call('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        clientUserMessageId: `${task.id}:${task.round}`,
        ...(config.effort ? { effort: config.effort } : {}),
      });
      const turnId = started.turn?.id;
      if (typeof turnId !== 'string' || (this.expectedTurn && this.expectedTurn !== turnId))
        throw new Error('Codex 轮次身份不一致');
      this.expectedTurn = turnId;
      if (this.cancelled && !this.finished) await rpc.call('turn/interrupt', { threadId, turnId });
      if (!this.finished) await this.patch({ turnId, phase: this.questions.size ? 'waiting' : 'running' });
      await Promise.race([
        this.done,
        rpc.exited.then(() => {
          if (!this.finished) throw new Error('Codex 执行中断，请读取原会话后继续');
        }),
      ]);
      await this.writes;
    } finally {
      await rpc.close();
    }
  }
  private notification(method: string, params: ObjectValue) {
    const childId = params.item?.type === 'subAgentActivity' ? params.item.agentThreadId : undefined;
    if (typeof childId === 'string' && childId !== this.task?.threadId) this.discoverChild(childId);
    if (params.threadId !== this.task?.threadId) this.childNotification(method, params);
    if (method === 'serverRequest/resolved') {
      this.resolved.add(`${params.threadId}:${params.requestId}`);
      const pending = this.questions.get(params.requestId);
      if (pending?.params.threadId === params.threadId) {
        this.questions.delete(params.requestId);
        if (!this.finished && !this.asyncQuestion)
          void this.patch({ phase: this.questions.size ? 'waiting' : 'running' });
      }
      return;
    }
    if (method === 'turn/completed') {
      const before = this.questions.size;
      this.endedTurns.add(`${params.threadId}:${params.turn?.id}`);
      for (const [id, question] of this.questions) {
        if (question.params.threadId === params.threadId && question.params.turnId === params.turn?.id)
          this.questions.delete(id);
      }
      if (
        before !== this.questions.size &&
        params.threadId !== this.task?.threadId &&
        !this.finished &&
        !this.asyncQuestion
      )
        void this.patch({ phase: this.questions.size ? 'waiting' : 'running' });
    }
    if (this.finished || params.threadId !== this.task?.threadId) return;
    const turnId = params.turnId ?? params.turn?.id;
    if (method === 'turn/started' && !this.expectedTurn) this.expectedTurn = turnId;
    if (!this.expectedTurn || turnId !== this.expectedTurn) return;
    if (method === 'item/completed' && params.item?.type === 'agentMessage') {
      if (params.item.delivery === 'async' && params.item.questions?.length) {
        this.asyncQuestion = {
          id: `async:${params.item.id}`,
          method: 'asyncQuestion',
          params: params.item,
          approval: false,
        };
        void this.patch({ pendingAsync: { itemId: params.item.id, threadId: params.threadId, turnId } });
        void this.interruptTree().catch(() => undefined);
      } else if (params.item.phase === 'final_answer' || !params.item.phase) this.state.result = params.item.text;
    }
    if (method === 'turn/completed') {
      this.rootResult = params.turn;
      this.finishIfIdle();
    }
  }
  private discoverChild(id: string) {
    if (this.children.has(id) || this.childChecks.has(id) || this.children.size >= 128) return;
    const check = (async () => {
      if (!(await this.belongs(id)) || !this.rpc || this.finished) return;
      const { thread } = await this.rpc.call('thread/read', { threadId: id, includeTurns: false });
      const active = thread.status?.type === 'active';
      const turn = active ? await readTurn(this.rpc, id) : undefined;
      const stillActive = active && (!turn || !this.endedTurns.has(`${id}:${turn.id}`));
      this.children.set(id, { active: stillActive, ...(stillActive && turn?.status === 'inProgress' ? { turnId: turn.id } : {}) });
    })()
      .catch(() => {
        // 归属或状态读取失败时保留占用，不能提前把整项委派报成完成。
        this.children.set(id, { active: true });
      })
      .finally(() => {
        this.childChecks.delete(id);
        this.finishIfIdle();
      });
    this.childChecks.set(id, check);
  }
  private childNotification(method: string, params: ObjectValue) {
    const child = this.children.get(params.threadId);
    if (!child) return;
    if (method === 'turn/started') {
      child.turnId = params.turn?.id;
      child.active = true;
    }
    if (method === 'turn/completed' && (!child.turnId || child.turnId === params.turn?.id)) {
      child.turnId = undefined;
      child.active = false;
    }
    if (method === 'thread/status/changed') child.active = params.status?.type === 'active';
    if (method === 'item/completed' && params.item?.delivery === 'async' && params.item.questions?.length) {
      this.asyncQuestion = {
        id: `async:${params.item.id}`,
        method: 'asyncQuestion',
        params: params.item,
        approval: false,
      };
      void this.patch({ pendingAsync: { itemId: params.item.id, threadId: params.threadId, turnId: params.turnId } });
      void this.interruptTree().catch(() => undefined);
    }
    this.finishIfIdle();
  }
  private finishIfIdle() {
    if (
      !this.rootResult ||
      this.finished ||
      this.childChecks.size ||
      [...this.children.values()].some((child) => child.active)
    )
      return;
    this.finished = true;
    this.questions.clear();
    void this.patch({
      turnId: this.rootResult.id,
      phase: this.asyncQuestion ? 'waiting' : nativePhase(this.rootResult.status, this.task),
      ...(this.rootResult.status === 'failed' ? { error: 'Codex 报告本轮执行失败，请查看原生会话' } : {}),
    });
    this.resolveDone();
  }
  private async interruptTree() {
    await Promise.all([...this.childChecks.values()]);
    for (const [threadId, child] of this.children) {
      if (child.active && child.turnId) await this.rpc?.call('turn/interrupt', { threadId, turnId: child.turnId });
    }
    if (this.rpc && this.task?.threadId && this.expectedTurn && !this.rootResult)
      await this.rpc.call('turn/interrupt', { threadId: this.task.threadId, turnId: this.expectedTurn });
  }
  private async belongs(threadId: unknown): Promise<boolean> {
    if (typeof threadId !== 'string' || !this.rpc || !this.task?.threadId) return false;
    let current = threadId;
    const visited = new Set<string>();
    while (!visited.has(current) && visited.size < 16) {
      if (current === this.task.threadId) return true;
      visited.add(current);
      const { thread } = await this.rpc.call('thread/read', { threadId: current, includeTurns: false });
      if (thread.id !== current || path.resolve(thread.cwd) !== path.resolve(this.task.cwd)) return false;
      const parent = thread?.source?.subAgent?.thread_spawn?.parent_thread_id;
      if (typeof parent !== 'string') return false;
      current = parent;
    }
    return false;
  }
  private async question(id: string | number, method: string, params: ObjectValue) {
    const supported =
      approvals.has(method) ||
      method === 'mcpServer/elicitation/request' ||
      method === 'item/tool/requestUserInput' ||
      (method === 'item/tool/call' && params.tool === 'ask_manager');
    if (!supported || this.finished || !(await this.belongs(params.threadId))) return this.rpc?.reject(id);
    if (
      this.finished ||
      this.resolved.has(`${params.threadId}:${id}`) ||
      this.endedTurns.has(`${params.threadId}:${params.turnId}`)
    )
      return;
    if (
      params.threadId === this.task?.threadId &&
      this.expectedTurn &&
      params.turnId &&
      params.turnId !== this.expectedTurn
    )
      return this.rpc?.reject(id);
    this.questions.set(id, {
      id,
      method,
      params,
      approval: approvals.has(method) || method === 'mcpServer/elicitation/request',
    });
    if (params.threadId !== this.task?.threadId) this.children.set(params.threadId, { active: true, turnId: params.turnId });
    await this.patch({ phase: 'waiting' });
  }
  snapshot(): NativeSnapshot {
    return { ...this.state, question: this.questions.values().next().value ?? this.asyncQuestion };
  }
  async answer(id: string | number, answer: unknown) {
    const question = this.questions.get(id);
    if (!question || !this.rpc || this.finished) throw new Error('该问题已失效，请重新读取任务');
    let result: unknown;
    if (question.method === 'mcpServer/elicitation/request') {
      const response = z
        .strictObject({
          action: z.enum(['accept', 'decline', 'cancel']),
          content: z.record(z.string(), z.json()).optional(),
        })
        .parse(answer);
      if (response.action === 'accept' && question.params.mode === 'form') {
        const schema = z.record(z.string(), z.json()).parse(question.params.requestedSchema);
        z.fromJSONSchema(schema).parse(response.content);
      }
      result = response;
    } else if (question.method === 'item/tool/call') {
      if (typeof answer !== 'string' || !answer.trim()) throw new Error('请输入明确答复');
      result = { contentItems: [{ type: 'inputText', text: answer }], success: true };
    } else if (question.method === 'item/tool/requestUserInput') {
      const answers = z.record(z.string(), z.strictObject({ answers: z.array(z.string()).min(1) })).parse(answer);
      const ids = new Set((question.params.questions as ObjectValue[]).map((item) => item.id));
      if (Object.keys(answers).length !== ids.size || Object.keys(answers).some((key) => !ids.has(key)))
        throw new Error('答复须逐项对应当前问题');
      result = { answers };
    } else {
      if (!['accept', 'decline', 'cancel'].includes(String(answer))) throw new Error('请选择允许、拒绝或取消');
      if (question.method === 'item/permissions/requestApproval') {
        if (answer === 'cancel') throw new Error('此权限请求可允许或拒绝；如需停止整个任务，请调用取消任务');
        result = { permissions: answer === 'accept' ? question.params.permissions : {}, scope: 'turn' };
      } else result = { decision: answer };
    }
    this.rpc.respond(id, result);
    this.questions.delete(id);
    await this.patch({ phase: this.questions.size ? 'waiting' : 'running' });
  }
  async cancel() {
    if (this.finished) return;
    this.cancelled = true;
    await this.interruptTree();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.done,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Codex 尚未确认停止，请重新读取任务')), 15_000);
        }),
      ]);
      await this.writes;
    } finally {
      clearTimeout(timer);
    }
  }
  private async cancelBeforeTurn() {
    if (!this.cancelled) return false;
    this.finished = true;
    await this.patch({ phase: 'cancelled' });
    this.resolveDone();
    return true;
  }
  async close() {
    await this.rpc?.close();
  }
}

async function withRpc<T>(cwd: string, action: (rpc: Rpc) => Promise<T>, createRpc: (cwd: string) => Rpc): Promise<T> {
  const rpc = createRpc(cwd);
  try {
    await rpc.initialize();
    return await action(rpc);
  } finally {
    await rpc.close();
  }
}

async function readTurn(rpc: Rpc, threadId: string, turnId?: string) {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const response = await rpc.call('thread/turns/list', {
      threadId,
      limit: 1,
      sortDirection: 'desc',
      itemsView: 'full',
      ...(cursor ? { cursor } : {}),
    });
    const turn = (response.data as ObjectValue[]).find((item) => !turnId || item.id === turnId);
    if (turn) return turn;
    if (!response.nextCursor) return undefined;
    cursor = response.nextCursor;
  }
  throw new Error('尚未读取到本轮结果，请在原生 Codex 会话查看');
}
export function createCodexNative(
  createRpc: RpcFactory = (cwd, environment) => new Rpc(cwd, undefined, environment),
): NativeFactory {
  return {
    run: (environment) => new CodexRun(createRpc, environment),
    read: (task) =>
      withRpc(
        task.cwd,
        async (rpc) => {
          if (!task.threadId || !task.turnId) return {};
          const { thread } = await rpc.call('thread/read', { threadId: task.threadId, includeTurns: false });
          if (thread.id !== task.threadId || path.resolve(thread.cwd) !== path.resolve(task.cwd))
            throw new Error('Codex 会话归属不一致');
          const turn = await readTurn(rpc, task.threadId, task.turnId);
          if (task.pendingAsync) {
            const questionTurn =
              task.pendingAsync.threadId === task.threadId
                ? turn
                : await readTurn(rpc, task.pendingAsync.threadId, task.pendingAsync.turnId);
            const question = (questionTurn?.items ?? []).find(
              (item: ObjectValue) => item.id === task.pendingAsync!.itemId && item.delivery === 'async',
            );
            if (question)
              return {
                phase: 'waiting',
                question: { id: `async:${question.id}`, method: 'asyncQuestion', params: question, approval: false },
              };
            throw new Error('未读到原生待答问题，请打开 Codex 会话核对');
          }
          return {
            result: resultText({ turns: turn ? [turn] : [] }, task.turnId),
            ...(turn && turn.status !== 'inProgress' ? { phase: nativePhase(turn.status, task) } : {}),
          };
        },
        (cwd) => createRpc(cwd, { ...process.env, ...(task.codexHome ? { CODEX_HOME: task.codexHome } : {}) }),
      ),
    remove: (task) =>
      withRpc(
        task.cwd,
        async (rpc) => {
          if (!task.threadId) return;
          let response: ObjectValue;
          try {
            response = await rpc.call('thread/read', { threadId: task.threadId, includeTurns: false });
          } catch (error) {
            const missing =
              error instanceof RpcFailure &&
              error.code === -32600 &&
              [`thread not found: ${task.threadId}`, `no rollout found for thread id ${task.threadId}`].includes(
                error.nativeMessage,
              );
            if (task.deleting && missing) return;
            throw error;
          }
          const { thread } = response;
          if (thread.id !== task.threadId || path.resolve(thread.cwd) !== path.resolve(task.cwd))
            throw new Error('Codex 会话归属不一致，未删除');
          await rpc.call('thread/delete', { threadId: task.threadId });
        },
        (cwd) => createRpc(cwd, { ...process.env, ...(task.codexHome ? { CODEX_HOME: task.codexHome } : {}) }),
      ),
    defaults: (cwd) =>
      withRpc(
        cwd,
        async (rpc) => {
          const { config } = await rpc.call('config/read', { cwd, includeLayers: false });
          const data: ObjectValue[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 40; page++) {
            const response = await rpc.call('model/list', {
              includeHidden: false,
              limit: 100,
              ...(cursor ? { cursor } : {}),
            });
            data.push(...response.data);
            if (!response.nextCursor) break;
            cursor = response.nextCursor;
            if (page === 39) throw new Error('模型目录超过读取范围，请在 Codex 原生配置中选择默认模型');
          }
          return {
            model: config.model,
            effort: config.model_reasoning_effort,
            sandbox: config.sandbox_mode,
            approvalPolicy: config.approval_policy,
            models: data,
          };
        },
        createRpc,
      ),
  };
}
export const codex = createCodexNative();
