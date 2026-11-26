import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { Engine } from '../src/runtime/engine';
import { createCodexNative } from '../src/native/codex';
import { Rpc } from '../src/native/rpc';

async function setup(scenario: string) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'delegate-native-'));
  const fixture = path.join(import.meta.dirname, 'fixtures', 'codex.cjs');
  const native = createCodexNative(
    (directory) => new Rpc(directory, { command: process.execPath, args: [fixture, scenario] }),
  );
  const engine = new Engine(path.join(cwd, 'state'), native);
  await engine.open();
  await engine.configure({ enabled: true });
  let step = 0;
  const bind = async (lastUserInput: string) => {
    const transcriptPath = path.join(cwd, 'transcript.jsonl');
    await writeFile(
      transcriptPath,
      JSON.stringify({ step_index: step++, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: lastUserInput }) +
        '\n',
    );
    return engine.bind({
      conversationId: '08602de8-18fe-46bd-bfb2-070035897cb9',
      workspacePaths: [cwd],
      transcriptPath,
      lastUserInput,
    });
  };
  const { token } = await bind('/with-codex 校验协议');
  const task = await engine.start(token, {
    requestId: 'native',
    title: '协议验证',
    instructions: '验证',
    acceptance: '原生状态正确',
  });
  return { engine, bind, token, task, cwd };
}
it('原生同步问题保留请求连接，校验问题 ID 后回到同一轮', async () => {
  const { engine, token, task } = await setup('question');
  const pending = await engine.wait(token, task.id, 2000);
  expect(pending.phase).toBe('waiting');
  expect(pending.question?.id).toBe(100);
  await expect(engine.answer(token, task.id, 100, { wrong: { answers: ['继续'] } })).rejects.toThrow('对应');
  await engine.answer(token, task.id, 100, { choice: { answers: ['继续'] } });
  const completed = await engine.wait(token, task.id, 2000);
  expect(completed).toMatchObject({ phase: 'completed', result: '原生结果', round: 1, turnId: pending.turnId });
});
it('原生权限请求必须先取得新的用户答复', async () => {
  const { engine, token, task, bind } = await setup('approval');
  await engine.wait(token, task.id, 2000);
  await expect(engine.answer(token, task.id, 100, 'accept')).rejects.toThrow('用户答复');
  await engine.automaticInput(task.owner, '自动接续消息');
  const automatic = await bind('自动接续消息');
  await expect(engine.answer(automatic.token, task.id, 100, 'accept')).rejects.toThrow('用户答复');
  const reply = await bind('允许这次命令');
  await engine.answer(reply.token, task.id, 100, 'accept');
  expect((await engine.wait(reply.token, task.id, 2000)).phase).toBe('completed');
});
it('根回合结束时仍保留运行中的原生子代理，后代结束后才完成委派', async () => {
  const { engine, token, task, cwd } = await setup('child-running');
  const completed = await engine.wait(token, task.id, 2000);
  expect(completed).toMatchObject({ phase: 'completed', result: '原生结果' });
  expect(await readFile(path.join(cwd, 'child-completed'), 'utf8')).toBe('done');
});
it('不能利用队首普通提问跳过后续审批的用户授权', async () => {
  const { engine, token, task, bind } = await setup('multiple');
  await engine.wait(token, task.id, 2000);
  await engine.automaticInput(task.owner, '自动验收');
  const automatic = await bind('自动验收');
  await expect(engine.answer(automatic.token, task.id, 101, 'accept')).rejects.toThrow('当前显示的问题');
  await engine.cancel(token, task.id);
});
it.each(['resolved', 'child-ended'])('原生 %s 通知使旧问题失效，迟到的归属查询不能恢复等待', async (scenario) => {
  const { engine, token, task } = await setup(scenario);
  await expect.poll(async () => (await engine.read(token, task.id)).phase).toBe('completed');
  const completed = await engine.read(token, task.id);
  expect(completed.phase).toBe('completed');
  expect(completed.question).toBeUndefined();
  await expect(engine.answer(token, task.id, 100, {})).rejects.toThrow();
});
it('原生异步问题先确认中断，再用同一会话的新回合答复', async () => {
  const { engine, token, task } = await setup('async');
  const waiting = await engine.wait(token, task.id, 2000);
  expect(waiting).toMatchObject({ phase: 'waiting', pendingAsync: { itemId: 'async-question' } });
  expect(waiting.question?.id).toBe('async:async-question');
  await engine.answer(token, task.id, 'async:async-question', '继续');
  const completed = await engine.wait(token, task.id, 2000);
  expect(completed).toMatchObject({ phase: 'completed', round: 2, threadId: waiting.threadId });
  expect(completed.turnId).not.toBe(waiting.turnId);
});

it('停用时异步答复保留问题，取消待答任务释放目录给排队任务', async () => {
  const { engine, token, task } = await setup('async');
  await engine.wait(token, task.id, 2000);
  await engine.configure({ enabled: false });
  await expect(engine.answer(token, task.id, 'async:async-question', '继续')).rejects.toThrow('已保留');
  expect((await engine.read(token, task.id)).pendingAsync?.itemId).toBe('async-question');
  await engine.configure({ enabled: true });
  const queued = await engine.start(token, {
    requestId: 'next',
    title: '下一项',
    instructions: '下一项',
    acceptance: '完成',
  });
  expect(queued.phase).toBe('queued');
  expect((await engine.cancel(token, task.id)).phase).toBe('cancelled');
  expect((await engine.wait(token, queued.id, 2000)).phase).toBe('completed');
});
