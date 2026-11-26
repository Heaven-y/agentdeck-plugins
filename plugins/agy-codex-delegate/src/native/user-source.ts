import { open } from 'node:fs/promises';

/** 从原生记录取得用户消息位置，避免后台回调或重复 Hook 重新授予已结束的授权。 */
export async function userMessageId(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    let end = (await handle.stat()).size;
    let suffix = '';
    while (end > 0) {
      const start = Math.max(0, end - 256 * 1024);
      const buffer = Buffer.alloc(end - start);
      await handle.read(buffer, 0, buffer.length, start);
      const lines = (buffer.toString('utf8') + suffix).split('\n');
      suffix = lines.shift() ?? '';
      if (start === 0) lines.unshift(suffix);
      for (const line of lines.reverse()) {
        if (!line.includes('USER_EXPLICIT') || !line.includes('USER_INPUT')) continue;
        try {
          const record = JSON.parse(line);
          if (record.source === 'USER_EXPLICIT' && record.type === 'USER_INPUT' && Number.isInteger(record.step_index))
            return `${record.step_index}:${record.created_at ?? ''}`;
        } catch {
          /* 不完整的首行留给下一块，其他损坏行不作为授权依据。 */
        }
      }
      if (suffix.length > 4 * 1024 * 1024) throw new Error('原生用户消息过大，无法核对委派来源');
      end = start;
    }
    throw new Error('未读取到原生用户消息，暂不能创建委派');
  } finally {
    await handle.close();
  }
}
