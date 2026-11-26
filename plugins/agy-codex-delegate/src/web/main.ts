import type {} from '../../../../sdk/browser';
import type { PluginContext } from '../../../../sdk/browser';
import type { Settings, Task } from '../runtime/types';

const api = window.agentdeck;
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fields = ['model', 'effort', 'sandbox', 'approvalPolicy'] as const;
let context: PluginContext | undefined;
let models: { model: string; displayName: string; supportedReasoningEfforts: { reasoningEffort: string }[] }[] = [];
let nativeModel = '';
let loaded = false;
let refreshing = false;
const delivered = new Set<string>();
const opened = new Map<string, Map<string, { revision: number; requestId: string }>>();
const taskRows = new Map<string, HTMLLIElement>();
const labels: Record<string, string> = {
  queued: '排队中',
  starting: '正在开始',
  running: '执行中',
  waiting: '等待答复',
  completed: '待验收',
  failed: '执行失败',
  cancelled: '已取消',
  interrupted: '执行中断',
};
const effortLabels: Record<string, string> = {
  auto: '自动',
  none: '关闭',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
  ultra: '超高',
};
const effortLabel = (value: string) => effortLabels[value] ?? value;
const report = (error: unknown) => {
  element('error').textContent = error instanceof Error ? error.message : '操作失败';
};

async function backend<T>(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<T> {
  const response = await api.backend.request<T & { message?: string }>({
    method,
    url,
    ...(body === undefined ? {} : { body }),
  });
  if (response.status >= 400) throw new Error(response.body?.message ?? '操作失败');
  return response.body;
}
function option(select: HTMLSelectElement, value: string, label: string) {
  const entry = document.createElement('option');
  entry.value = value;
  entry.textContent = label;
  select.append(entry);
}
function efforts() {
  const select = element<HTMLSelectElement>('effort');
  const previous = select.value;
  select.replaceChildren();
  option(select, '', '沿用原生配置');
  const model = element<HTMLSelectElement>('model').value || nativeModel;
  for (const value of models.find((item) => item.model === model)?.supportedReasoningEfforts ?? [])
    option(select, value.reasoningEffort, effortLabel(value.reasoningEffort));
  if (previous && !Array.from(select.options).some((item) => item.value === previous))
    option(select, previous, `${effortLabel(previous)}（当前设置）`);
  select.value = previous;
}
async function settings() {
  const value = await backend<{ config: Settings; installed: boolean; permission: { allowed: boolean } }>(
    'GET',
    '/settings',
  );
  element('setup').hidden = value.installed && value.permission.allowed;
  if (!loaded) {
    for (const field of fields) {
      const select = element<HTMLSelectElement>(field);
      const current = value.config[field] ?? '';
      if (current && !Array.from(select.options).some((item) => item.value === current))
        option(select, current, field === 'effort' ? effortLabel(current) : current);
      select.value = current;
    }
    loaded = true;
  }
}
async function defaults() {
  const value = await backend<{ models: typeof models; model?: string }>('POST', '/defaults', {
    ...(context?.project ? { cwd: context.project.dir } : {}),
  });
  models = value.models ?? [];
  nativeModel = value.model ?? '';
  const select = element<HTMLSelectElement>('model');
  const previous = select.value;
  select.replaceChildren();
  option(select, '', nativeModel ? `沿用原生配置（${nativeModel}）` : '沿用原生配置');
  for (const model of models) option(select, model.model, model.displayName || model.model);
  if (previous && !models.some((item) => item.model === previous)) option(select, previous, previous);
  select.value = previous;
  efforts();
}
function taskRow(task: Task) {
  const row = document.createElement('li');
  const line = document.createElement('div');
  line.className = 'row';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = task.title;
  const status = document.createElement('span');
  status.className = 'status';
  status.textContent = task.accepted ? '已验收' : (labels[task.phase] ?? task.phase);
  line.append(title, status);
  const time = document.createElement('span');
  time.className = 'time muted';
  time.textContent = `第 ${task.round} 轮 · ${new Date(task.updatedAt).toLocaleString('zh-CN')}`;
  const details = document.createElement('div');
  details.className = 'task-detail';
  const summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'detail-button';
  summary.textContent = '查看详情';
  summary.setAttribute('aria-expanded', 'false');
  const content = document.createElement('pre');
  content.id = `task-detail-${task.id}`;
  summary.setAttribute('aria-controls', content.id);
  content.hidden = true;
  summary.onclick = () => {
    content.hidden = !content.hidden;
    summary.setAttribute('aria-expanded', String(!content.hidden));
    summary.textContent = content.hidden ? '查看详情' : '收起详情';
  };
  content.textContent = `工作目录：${task.cwd}\nCodex 会话：${task.threadId ?? '尚未创建'}${task.actual?.model ? `\n模型：${task.actual.model}` : ''}${task.actual?.effort ? `\n思考强度：${effortLabel(String(task.actual.effort))}` : ''}${task.error ? `\n${task.error}` : ''}`;
  details.append(summary, content);
  row.append(line, time, details);
  return row;
}
function renderTasks(tasks: Task[]) {
  for (const [id, row] of taskRows)
    if (!tasks.some((task) => task.id === id)) {
      row.remove();
      taskRows.delete(id);
    }
  for (const task of tasks) {
    const row = taskRows.get(task.id);
    if (!row) {
      const created = taskRow(task);
      taskRows.set(task.id, created);
      element('tasks').prepend(created);
    } else {
      row.querySelector('.status')!.textContent = task.accepted ? '已验收' : (labels[task.phase] ?? task.phase);
      row.querySelector('.time')!.textContent =
        `第 ${task.round} 轮 · ${new Date(task.updatedAt).toLocaleString('zh-CN')}`;
      row.querySelector('pre')!.textContent = taskRow(task).querySelector('pre')!.textContent;
    }
  }
}
async function resumePending(tasks: Task[]) {
  const sessions = await api.session.list();
  for (const id of opened.keys())
    if (!sessions.some((session) => (session.openId ?? session.conversationId) === id)) opened.delete(id);
  for (const session of sessions) {
    const openId = session.openId ?? session.conversationId;
    if (opened.has(openId)) continue;
    // 后台工具读到结果不等于 AGY 已验收；重开时接续尚未验收的完成结果。
    opened.set(
      openId,
      new Map(
        tasks
          .filter((task) => task.owner === session.sessionId && task.phase === 'completed' && !task.accepted)
          .map((task) => [task.id, { revision: task.revision, requestId: crypto.randomUUID() }]),
      ),
    );
  }
  for (const task of tasks) {
    if (!task.notificationId || task.accepted) continue;
    if (!['completed', 'waiting', 'failed', 'interrupted'].includes(task.phase)) continue;
    const session = sessions.find(
      (item) => item.agent === 'antigravity' && item.sessionId === task.owner && !item.running,
    );
    if (!session) continue;
    const reopened = opened.get(session.openId ?? session.conversationId)?.get(task.id);
    const review = reopened?.revision === task.revision ? reopened : undefined;
    const requestId = review?.requestId ?? task.notificationId;
    if (delivered.has(requestId) || (!review && task.deliveredRevision === task.revision)) continue;
    const text = `【Codex 委派】“${task.title}”第 ${task.round} 轮有待处理结果，请读取并继续处理问题或验收。`;
    await backend('POST', '/automatic-input', { owner: task.owner, text });
    const result = await api.session.resume({
      conversationId: session.conversationId,
      requestId,
      text,
    });
    if (result.accepted) {
      delivered.add(requestId);
    }
  }
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    await settings();
    const tasks = await backend<Task[]>('GET', '/tasks');
    if (context?.visible) {
      renderTasks(tasks);
      element('empty').hidden = tasks.length > 0;
    }
    await resumePending(tasks);
  } finally {
    refreshing = false;
  }
}
api.onContext((value) => {
  const changedPage = context?.page?.id !== value.page?.id || context?.project?.id !== value.project?.id;
  const becameVisible = value.visible && !context?.visible;
  context = value;
  for (const [key, color] of Object.entries(value.colors)) document.documentElement.style.setProperty(key, color);
  document.documentElement.style.colorScheme = value.theme;
  void refresh().catch(report);
  if (value.visible && value.page?.id === 'settings' && (changedPage || becameVisible)) void defaults().catch(report);
});
api.onCommand(async (id) => {
  if (id !== 'with-codex') return;
  const session = await api.session.get();
  if (session?.agent !== 'antigravity') throw new Error('请先打开 AGY 对话');
  const draft = await api.composer.get();
  await api.composer.set({
    text: /^\/with-codex(?:\s|$)/.test(draft.text) ? draft.text : `/with-codex ${draft.text}`,
    revision: draft.revision,
  });
});
for (const name of ['context.changed', 'turn.completed'] as const)
  api.onEvent(name, () => {
    void refresh().catch(report);
  });
element('refresh').onclick = () => {
  element('error').textContent = '';
  void refresh()
    .then(() => (context?.page?.id === 'settings' ? defaults() : undefined))
    .catch(report);
};
element('model').onchange = () => {
  element<HTMLSelectElement>('effort').value = '';
  efforts();
  element('saved').textContent = '';
};
element<HTMLFormElement>('settings').onsubmit = (event) => {
  event.preventDefault();
  const button = element<HTMLButtonElement>('save');
  button.disabled = true;
  const config = Object.fromEntries(
    fields.flatMap((name) =>
      element<HTMLSelectElement>(name).value ? [[name, element<HTMLSelectElement>(name).value]] : [],
    ),
  );
  void backend('PUT', '/settings', config)
    .then(() => {
      element('saved').textContent = '已保存';
      element('error').textContent = '';
    })
    .catch(report)
    .finally(() => {
      button.disabled = false;
    });
};
element('install').onclick = () => {
  const button = element<HTMLButtonElement>('install');
  button.disabled = true;
  button.textContent = '正在连接…';
  void backend('POST', '/install', { allowDelegation: true })
    .then(refresh)
    .catch(report)
    .finally(() => {
      button.disabled = false;
      button.textContent = '连接并允许委派';
    });
};
setInterval(() => {
  void refresh().catch((error) => {
    if (context?.visible) report(error);
  });
}, 5000);
void refresh().catch(report);
