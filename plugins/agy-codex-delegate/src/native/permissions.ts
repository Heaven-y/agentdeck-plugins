import path from 'node:path';
import { homedir } from 'node:os';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const delegationRule = 'mcp(agy-codex-delegate_codex_delegate/*)';
const configPath = () => path.join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');
type Config = { permissions?: { allow?: string[]; deny?: string[]; ask?: string[] }; [key: string]: unknown };
const matches = (rule: string) => rule === 'mcp(*)' || rule.startsWith('mcp(agy-codex-delegate_codex_delegate/');

async function load(file: string) {
  const content = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '{}\n';
    throw error;
  });
  const config: Config = JSON.parse(content);
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('AGY 配置格式不正确，请修复后再连接');
  for (const field of ['allow', 'deny', 'ask'] as const) {
    const rules = config.permissions?.[field];
    if (rules !== undefined && (!Array.isArray(rules) || rules.some((rule) => typeof rule !== 'string')))
      throw new Error('AGY 权限规则格式不正确，请先修复原生配置');
  }
  return { content, config };
}
export async function permissionStatus(file = configPath()) {
  const { config } = await load(file);
  const blocked = [...(config.permissions?.deny ?? []), ...(config.permissions?.ask ?? [])].some(matches);
  return {
    allowed: !blocked && (config.permissions?.allow ?? []).some((rule) => rule === delegationRule || rule === 'mcp(*)'),
  };
}

/** 用户点击连接时增加插件专属规则，保留现有拒绝或询问规则。 */
export async function allowDelegation(file = configPath()): Promise<boolean> {
  const { content, config } = await load(file);
  if ([...(config.permissions?.deny ?? []), ...(config.permissions?.ask ?? [])].some(matches))
    throw new Error('AGY 已有针对委派工具的拒绝或询问规则，请在原生权限设置中调整');
  if ((config.permissions?.allow ?? []).some((rule) => rule === delegationRule || rule === 'mcp(*)')) return false;
  config.permissions ??= {};
  config.permissions.allow = [...(config.permissions.allow ?? []), delegationRule];
  await save(file, content, config);
  return true;
}
export async function removeDelegationRule(file = configPath()) {
  const { content, config } = await load(file);
  if (!config.permissions?.allow?.includes(delegationRule)) return;
  config.permissions.allow = config.permissions.allow.filter((rule) => rule !== delegationRule);
  await save(file, content, config);
}
async function save(file: string, previous: string, config: Config) {
  await mkdir(path.dirname(file), { recursive: true });
  if ((await load(file)).content !== previous) throw new Error('AGY 配置刚被修改，请重新连接');
  const indent = /\n([\t ]+)"/.exec(previous)?.[1] ?? '  ';
  const temporary = `${file}.${randomUUID()}.next`;
  await writeFile(temporary, `${JSON.stringify(config, null, indent)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
}
