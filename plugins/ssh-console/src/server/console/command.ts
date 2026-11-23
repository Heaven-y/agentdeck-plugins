import { runExec, type ExecResult } from '../ssh/transport/exec';
import type { SshPool } from '../ssh/transport/pool';
import type { ConsoleLease } from './access';

/**
 * 在控制台租约上跑一条只读命令。
 *
 * 通道归本次调用所有：结束、取消或超时都只关这条通道，不碰共享连接。
 * 前后各复核一次租约，旧连接的结果不会流进新代次的界面。
 */
export async function runConsoleCommand(
  pool: SshPool,
  lease: ConsoleLease,
  request: { command: string; signal: AbortSignal; timeoutMs: number; outputCap: number },
): Promise<ExecResult> {
  const { command, signal, timeoutMs, outputCap } = request;
  const combined = AbortSignal.any([lease.signal, signal]);
  let channel: Awaited<ReturnType<SshPool['openExec']>> | undefined;
  const cancel = () => channel?.close();
  combined.addEventListener('abort', cancel, { once: true });
  try {
    lease.check();
    combined.throwIfAborted();
    const result = await runExec(
      async (text) => {
        channel = await pool.openExec(lease.target, text, combined);
        channel.on('error', () => undefined);
        if (combined.aborted) {
          channel.close();
          combined.throwIfAborted();
        }
        return channel;
      },
      command,
      { localTimeoutMs: timeoutMs, outputCap },
    );
    combined.throwIfAborted();
    await lease.recheck();
    return result;
  } finally {
    combined.removeEventListener('abort', cancel);
    channel?.close();
  }
}
