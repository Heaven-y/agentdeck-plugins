import { z } from 'zod';
import type { Engine } from './engine';

const string = { type: 'string' };
const identity = { taskId: string };
const schema = (properties: object, required: string[]) => ({
  type: 'object' as const,
  properties,
  required,
  additionalProperties: true,
});
export const toolDefinitions = [
  {
    name: 'codex_start',
    description: '将已澄清的当前授权任务交给 Codex；相同 requestId 重试返回同一任务。先明确目标、范围和验收条件。',
    inputSchema: schema({ requestId: string, title: string, instructions: string, acceptance: string }, [
      'requestId',
      'title',
      'instructions',
      'acceptance',
    ]),
  },
  {
    name: 'codex_wait',
    description: '在后台等待当前任务，完成或需要答复时返回；超时返回运行状态，继续等待同一 taskId。',
    inputSchema: schema(identity, ['taskId']),
  },
  {
    name: 'codex_read',
    description: '读取本会话委派任务的原生结果、当前问题和实际配置。',
    inputSchema: schema(identity, ['taskId']),
  },
  {
    name: 'codex_answer',
    description: '回答 Codex 当前问题；原生权限审批须先在 AGY 主对话取得用户答复。',
    inputSchema: schema({ ...identity, questionId: { type: ['string', 'number'] }, answer: {} }, [
      'taskId',
      'questionId',
      'answer',
    ]),
  },
  {
    name: 'codex_continue',
    description: '向同一个 Codex 会话明确补充或返修；保持原任务范围，新任务先取得新的 /with-codex 授权。',
    inputSchema: schema({ ...identity, requestId: string, instructions: string }, [
      'taskId',
      'requestId',
      'instructions',
    ]),
  },
  {
    name: 'codex_cancel',
    description: '主动取消当前任务，确认原生停止后返回，保留项目文件及会话。',
    inputSchema: schema(identity, ['taskId']),
  },
  {
    name: 'codex_accept',
    description: '检查实际成果和验证后，记录当前轮验收通过。',
    inputSchema: schema({ ...identity, revision: { type: 'integer' } }, ['taskId', 'revision']),
  },
  {
    name: 'codex_finish_scope',
    description:
      '结束本次任务的委派授权。验收交付、无需 Codex，或用户转向无关新任务时调用；原任务返修仍可按 taskId 续接。',
    inputSchema: schema({}, []),
  },
];

const Source = z.object({ _context: z.string().min(1).max(4000) }).passthrough();
const TaskId = z.string().uuid();
export async function invoke(
  engine: Engine,
  name: string,
  input: unknown,
  options: { nativeOwner?: string; signal?: AbortSignal; environment?: NodeJS.ProcessEnv } = {},
) {
  const { nativeOwner, signal, environment } = options;
  const args = Source.parse(input);
  const token = args._context;
  const binding = engine.store.verify(token);
  if (nativeOwner && nativeOwner !== binding.owner) throw new Error('原生会话与委派来源不一致');
  const taskId = name !== 'codex_start' && name !== 'codex_finish_scope' ? TaskId.parse(args.taskId) : '';
  if (name === 'codex_start') {
    const { _context, ...task } = args;
    return engine.start(token, task, environment);
  }
  if (name === 'codex_finish_scope') return engine.finishScope(token);
  if (name === 'codex_continue')
    return engine.continue(
      token,
      taskId,
      { requestId: z.string().parse(args.requestId), instructions: z.string().parse(args.instructions) },
      environment,
    );
  if (name === 'codex_cancel') return engine.cancel(token, taskId);
  if (name === 'codex_answer')
    return engine.answer(
      token,
      taskId,
      z.union([z.string(), z.number()]).parse(args.questionId),
      args.answer,
      environment,
    );
  if (name === 'codex_accept') return engine.acknowledge(token, taskId, z.number().int().parse(args.revision), true);
  if (name !== 'codex_read' && name !== 'codex_wait') throw new Error('未知 Codex 工具');
  const result =
    name === 'codex_wait' ? await engine.wait(token, taskId, 120_000, signal) : await engine.read(token, taskId);
  if (['waiting', 'completed', 'failed', 'cancelled', 'interrupted'].includes(result.phase))
    await engine.acknowledge(token, taskId, result.revision);
  return result;
}
