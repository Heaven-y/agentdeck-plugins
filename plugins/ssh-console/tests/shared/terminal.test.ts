import { describe, expect, it } from 'vitest';
import { TERMINAL_LIMITS, TerminalInputSchema, TerminalSizeSchema } from '../../src/shared/terminal';

describe('TerminalSizeSchema', () => {
  it('接受常规行列，拒绝过小与越界', () => {
    expect(TerminalSizeSchema.safeParse({ cols: 100, rows: 30 }).success).toBe(true);
    expect(TerminalSizeSchema.safeParse({ cols: 1, rows: 30 }).success).toBe(false);
    expect(TerminalSizeSchema.safeParse({ cols: 100, rows: 501 }).success).toBe(false);
    expect(TerminalSizeSchema.safeParse({ cols: 100.5, rows: 30 }).success).toBe(false);
    expect(TerminalSizeSchema.safeParse({ cols: 100, rows: 30, extra: 1 }).success).toBe(false);
  });
});

describe('TerminalInputSchema', () => {
  it('接受标准 base64 空串与单字节', () => {
    expect(TerminalInputSchema.safeParse('').success).toBe(true);
    expect(TerminalInputSchema.safeParse('YQ==').success).toBe(true);
    expect(TerminalInputSchema.safeParse('YWI=').success).toBe(true);
    expect(TerminalInputSchema.safeParse('YWJj').success).toBe(true);
  });

  it('拒绝非 base64 字符与长度不合法', () => {
    expect(TerminalInputSchema.safeParse('YQ=').success).toBe(false);
    expect(TerminalInputSchema.safeParse('YQ').success).toBe(false);
    expect(TerminalInputSchema.safeParse('Y Q==').success).toBe(false);
    expect(TerminalInputSchema.safeParse('中文==').success).toBe(false);
  });

  it('拒绝规范化后不同的 padding 位，避免同一字节多种编码', () => {
    // 'YR==' 的第二个字符携带被丢弃的位：解码仍是 'a'，但编码不唯一。
    expect(TerminalInputSchema.safeParse('YR==').success).toBe(false);
    expect(TerminalInputSchema.safeParse('YWJ=').success).toBe(false);
  });

  it('拒绝解码后超过单帧字节上限的输入', () => {
    const atLimit = Buffer.alloc(TERMINAL_LIMITS.frameBytes).toString('base64');
    expect(TerminalInputSchema.safeParse(atLimit).success).toBe(true);
    const overLimit = Buffer.alloc(TERMINAL_LIMITS.frameBytes + 1).toString('base64');
    expect(TerminalInputSchema.safeParse(overLimit).success).toBe(false);
  });
});
