import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/runtime/engine';
import type { NativeFactory, NativeRun, NativeSnapshot, Task } from '../src/runtime/types';

const owner = '6d5cabd0-15ef-4bed-99e0-fb0f3c0c7678';
const taskInput = { requestId: 'first', title: '验证任务', instructions: '读取示例', acceptance: '返回核对结果' };
function controlledNative() {
  const runs: { task: Task; complete(): void; ask(): Promise<void>; state: NativeSnapshot }[] = [];
  const factory: NativeFactory = {
    run() {
      let entry: (typeof runs)[number];
      const run: NativeRun = {
        async start(task, _text, update) {
          let finish!: () => void;
          const done = new Promise<void>((resolve) => {
            finish = resolve;
          });
          entry = {
            task,
            state: { phase: 'running' },
            complete: () => {
              entry.state = { phase: 'completed', result: '已验证' };
              void update({ phase: 'completed' }).then(finish);
            },
            ask: async () => {
              entry.state = {
                phase: 'waiting',
                question: { id: 1, method: 'item/tool/call', params: {}, approval: false },
              };
              await update({ phase: 'waiting' });
            },
          };
          runs.push(entry);
          await update({
            threadId: task.threadId ?? `native-${task.id}`,
            turnId: `turn-${task.round}`,
            phase: 'running',
          });
          await done;
        },
        snapshot: () => entry?.state ?? { phase: 'starting' },
        answer: async () => {
          entry.state = { phase: 'running' };
        },
        cancel: async () => {
          entry.state = { phase: 'cancelled' };
          entry.complete();
        },
        close: async () => {},
      };
      return run;
    },
    read: async () => ({ result: '已验证', phase: 'completed' }),
    remove: async () => {},
    defaults: async () => ({}),
  };
  return { factory, runs };
}
async function setup() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'delegate-core-'));
  const native = controlledNative();
  const engine = new Engine(path.join(cwd, 'state'), native.factory);
  await engine.open();
  await engine.configure({ enabled: true });
  let step = 0;
  const hook = async (lastUserInput: string, conversationId = owner, repeat = false) => {
    const transcriptPath = path.join(cwd, `${conversationId}.jsonl`);
    if (!repeat)
      await writeFile(
        transcriptPath,
        JSON.stringify({ step_index: step++, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: lastUserInput }) +
          '\n',
      );
    return engine.bind({ conversationId, workspacePaths: [cwd], transcriptPath, lastUserInput });
  };
  return { cwd, engine, hook, ...native };
}

describe('委派任务的外部接口', () => {
  it('授权后的澄清答复可分派多项工作，重复请求仍返回同一任务', async () => {
    const { engine, hook, runs } = await setup();
    await hook('/with-codex 检查两项');
    const { token } = await hook('范围仅这两个文件');
    const first = await engine.start(token, taskInput);
    expect((await engine.start(token, taskInput)).id).toBe(first.id);
    const next = await engine.start(token, { ...taskInput, requestId: 'other' });
    expect(next.phase).toBe('queued');
    runs[0]!.complete();
    await engine.wait(token, first.id, 1000);
    runs.at(-1)!.complete();
  });
  it('普通消息不能创建委派，用户命令授权后重复调用只创建一次', async () => {
    const { engine, hook, runs } = await setup();
    const plain = await hook('请检查代码');
    await expect(engine.start(plain.token, taskInput)).rejects.toThrow('with-codex');
    const granted = await hook('/with-codex 请检查代码');
    const first = await engine.start(granted.token, taskInput);
    const again = await engine.start(granted.token, taskInput);
    expect(again.id).toBe(first.id);
    expect(runs).toHaveLength(1);
    await expect(engine.start(granted.token, { ...taskInput, instructions: '另一个任务' })).rejects.toThrow(
      '内容不一致',
    );
    runs[0]!.complete();
  });
  it('同目录独立任务排队，结束后启动下一项；返修保持原会话', async () => {
    const { engine, hook, runs } = await setup();
    const { token } = await hook('/with-codex 检查两项');
    const first = await engine.start(token, taskInput);
    const second = await engine.start(token, { ...taskInput, requestId: 'second' });
    expect(runs).toHaveLength(1);
    expect(second.phase).toBe('queued');
    runs[0]!.complete();
    await engine.wait(token, first.id, 1000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toHaveLength(2);
    runs[1]!.complete();
    const original = await engine.read(token, first.id);
    const resumed = await engine.continue(token, first.id, { requestId: 'repair', instructions: '补充验证' });
    expect(resumed.threadId).toBe(original.threadId);
    expect(resumed.round).toBe(2);
    const duplicate = await engine.continue(token, first.id, { requestId: 'repair', instructions: '补充验证' });
    expect(duplicate.round).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    runs.at(-1)!.complete();
  });
  it('其他会话不能读写原任务；关闭授权后普通消息不能创建新任务', async () => {
    const { engine, hook, runs } = await setup();
    const first = await hook('/with-codex 原任务');
    const task = await engine.start(first.token, taskInput);
    const other = await hook('/with-codex 另一个会话', 'dddf75a6-a374-4696-89fb-d36a65523615');
    await expect(engine.read(other.token, task.id)).rejects.toThrow('不属于');
    await engine.finishScope(first.token);
    const repeatedHook = await hook('/with-codex 原任务', owner, true);
    await expect(engine.start(repeatedHook.token, { ...taskInput, requestId: 'stale' })).rejects.toThrow('with-codex');
    const plain = await hook('一个新任务');
    await expect(engine.start(plain.token, { ...taskInput, requestId: 'new' })).rejects.toThrow('with-codex');
    runs[0]!.complete();
    const repair = await engine.continue(plain.token, task.id, { requestId: 'repair', instructions: '返修原任务' });
    expect(repair.round).toBe(2);
    runs.at(-1)!.complete();
  });
  it('问题立即结束等待，停用不取消已有执行，重启不重复提交', async () => {
    const { engine, hook, runs, factory, cwd } = await setup();
    const { token } = await hook('/with-codex 原任务');
    const task = await engine.start(token, taskInput);
    await runs[0]!.ask();
    expect((await engine.wait(token, task.id, 120_000)).phase).toBe('waiting');
    await engine.configure({ enabled: false });
    await expect(engine.start(token, { ...taskInput, requestId: 'new' })).rejects.toThrow('停用');
    await engine.answer(token, task.id, 1, '继续');
    expect(runs).toHaveLength(1);
    runs[0]!.complete();
    await engine.wait(token, task.id, 1000);
    const restored = new Engine(path.join(cwd, 'state'), factory);
    await restored.open();
    expect(restored.list()[0]?.id).toBe(task.id);
    expect(runs).toHaveLength(1);
  });
});
