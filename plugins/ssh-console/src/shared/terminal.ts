import { z } from 'zod';

/** 终端专用限制；正文不进入聊天协议或持久存储。 */
export const TERMINAL_LIMITS = {
  frameBytes: 32_768,
  inputBytes: 262_144,
  initBytes: 131_072,
  initMs: 10_000,
  panes: 4,
  scrollback: 2_000,
} as const;

export const TerminalSizeSchema = z.strictObject({
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(2).max(500),
});
/**
 * 终端输入是标准 base64 的按键字节。
 *
 * 空串是合法的「没有按键」，不需要拒；regex 只接受规范化编码（拒绝 `YR==`
 * 这类未使用位非零的写法），refine 再把解码后的字节数卡在单帧预算内。
 */
export const TerminalInputSchema = z
  .string()
  .max(Math.ceil(TERMINAL_LIMITS.frameBytes / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/)
  .refine(
    (value) =>
      (value.length / 4) * 3 - (value.endsWith('==') ? 2 : Number(value.endsWith('='))) <= TERMINAL_LIMITS.frameBytes,
  );
export type TerminalSize = z.infer<typeof TerminalSizeSchema>;
