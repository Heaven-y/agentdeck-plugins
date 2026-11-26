import guide from '../../native/skills/with-codex/SKILL.md';
import { request } from '../runtime/transport';
import type { Task } from '../runtime/types';

export async function handleHook(directory: string, event: string, input: Record<string, any>) {
  const binding = await request(directory, 'bind', { ...input, event });
  if (event === 'PreToolUse') {
    const name = input.toolCall?.name ?? '';
    if (
      name === 'call_mcp_tool' &&
      ['codex_delegate', 'agy-codex-delegate_codex_delegate'].includes(input.toolCall.args?.ServerName)
    )
      return {
        decision: 'allow',
        overwrite: { Arguments: { ...input.toolCall.args.Arguments, _context: binding.token } },
      };
    if (!/^mcp_(?:agy-codex-delegate_)?codex_delegate_/.test(name)) return { decision: 'allow' };
    return { decision: 'allow', overwrite: { _context: binding.token } };
  }
  const tasks: Task[] = binding.tasks;
  const pending = tasks.filter((task) => !task.accepted);
  if (event === 'Stop') {
    if (input.terminationReason !== 'model_stop' || input.fullyIdle === false) return {};
    const running = pending.find((task) => ['starting', 'queued', 'running'].includes(task.phase));
    if (running)
      return { decision: 'continue', reason: `委派任务 ${running.id} 仍在执行，请调用 codex_wait 等待原任务。` };
    return {};
  }
  if (!binding.inject || (!binding.granted && !pending.length)) return {};
  const summary = pending
    .slice(-12)
    .map((task) => ({ taskId: task.id, title: task.title, phase: task.phase, round: task.round }));
  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: `${guide.replace(/^---[\s\S]*?---\s*/, '')}\n\n当前委派授权：${binding.granted ? '本次任务及返修' : '只能续接已有任务，新任务需 /with-codex'}。\n关联任务：${JSON.stringify(summary)}`,
        },
      },
    ],
  };
}

export const nativeGuide = guide;
