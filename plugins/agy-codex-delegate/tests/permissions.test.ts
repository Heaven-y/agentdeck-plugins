import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { allowDelegation, delegationRule, permissionStatus, removeDelegationRule } from '../src/native/permissions';

it('连接只增加委派工具权限，保留已有配置，重复连接不重复写入', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'delegate-permissions-'));
  const file = path.join(directory, 'settings.json');
  const original = {
    model: 'example-model',
    extra: { preserved: true },
    permissions: { allow: ['command(git)'], deny: ['write_file(.git/)'] },
  };
  await writeFile(file, JSON.stringify(original));
  expect(await allowDelegation(file)).toBe(true);
  expect(await allowDelegation(file)).toBe(false);
  expect(await permissionStatus(file)).toEqual({ allowed: true });
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
    ...original,
    permissions: { ...original.permissions, allow: ['command(git)', delegationRule] },
  });
  await removeDelegationRule(file);
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(original);
});
it('连接不覆盖已有的明确拒绝或询问规则', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'delegate-permissions-'));
  const file = path.join(directory, 'settings.json');
  const content = JSON.stringify({ permissions: { deny: ['mcp(*)'] } });
  await writeFile(file, content);
  await expect(allowDelegation(file)).rejects.toThrow('拒绝或询问');
  expect(await readFile(file, 'utf8')).toBe(content);
});
