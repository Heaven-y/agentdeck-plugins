const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const scenario = process.argv[2];
const file = path.join(process.cwd(), 'native-fixture.json');
let saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { count: 0, turns: [] };
const root = 'b5e5cd47-e70f-4df8-a69f-e87a0c83295d';
const child = 'bbfd1df8-2029-480b-83d3-075b9e3cfbd6';
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => out({ id, result });
const event = (method, params) => out({ method, params });
const save = () => fs.writeFileSync(file, JSON.stringify(saved));
let current;
function complete(status = 'completed') {
  current.status = status;
  current.items.push({ type: 'agentMessage', id: 'final', phase: 'final_answer', text: '原生结果' });
  event('item/completed', { threadId: root, turnId: current.id, item: current.items.at(-1) });
  save();
  event('turn/completed', { threadId: root, turn: current });
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const value = JSON.parse(line);
  if (value.id === 100 && !value.method) {
    if (scenario === 'question' && value.result.answers.choice.answers[0] !== '继续') process.exit(3);
    event('serverRequest/resolved', { threadId: root, requestId: 100 });
    complete();
    return;
  }
  const params = value.params || {};
  if (value.method === 'initialize') return reply(value.id, {});
  if (value.method === 'thread/start' || value.method === 'thread/resume')
    return reply(value.id, {
      thread: { id: root, cwd: process.cwd(), path: file },
      model: 'native-model',
      reasoningEffort: 'high',
      approvalPolicy: 'on-request',
      sandbox: { type: 'workspaceWrite' },
    });
  if (value.method === 'thread/read') {
    if (params.threadId === child && scenario === 'child-ended')
      event('turn/completed', { threadId: child, turn: { id: 'child-turn', status: 'completed' } });
    return reply(value.id, {
      thread: {
        id: params.threadId,
        cwd: process.cwd(),
        source: params.threadId === child ? { subAgent: { thread_spawn: { parent_thread_id: root } } } : 'cli',
        status: { type: params.threadId === child && scenario === 'child-running' ? 'active' : 'idle' },
      },
    });
  }
  if (value.method === 'thread/turns/list')
    return reply(value.id, {
      data: params.threadId === child ? [{ id: 'child-turn', status: 'inProgress', items: [] }] : saved.turns.filter((turn) => !params.cursor || turn.id === params.cursor).slice(-1),
      nextCursor: null,
    });
  if (value.method === 'turn/start') {
    current = { id: `turn-${++saved.count}`, status: 'inProgress', items: [] };
    saved.turns.push(current);
    save();
    event('turn/started', { threadId: root, turn: current });
    reply(value.id, { turn: current });
    if (scenario === 'child-running') {
      event('item/completed', { threadId: root, turnId: current.id, item: { type: 'subAgentActivity', agentThreadId: child } });
      complete();
      setTimeout(() => { fs.writeFileSync(path.join(process.cwd(), 'child-completed'), 'done'); event('turn/completed', { threadId: child, turn: { id: 'child-turn', status: 'completed' } }); }, 150);
      return;
    }
    if (saved.count > 1) return complete();
    if (scenario === 'async') {
      const item = {
        type: 'agentMessage',
        id: 'async-question',
        delivery: 'async',
        questions: [{ title: '选择范围', options: ['继续', '停止'] }],
        text: '选择范围',
      };
      current.items.push(item);
      save();
      return event('item/completed', { threadId: root, turnId: current.id, item });
    }
    const approval = scenario === 'approval';
    const owner = scenario === 'child-ended' ? child : root;
    out({
      id: 100,
      method: approval ? 'item/commandExecution/requestApproval' : 'item/tool/requestUserInput',
      params: {
        threadId: owner,
        turnId: owner === child ? 'child-turn' : current.id,
        itemId: 'question',
        questions: [
          { id: 'choice', question: '选择范围', header: '范围', options: [{ label: '继续', description: '继续' }] },
        ],
        isBlocking: false,
      },
    });
    if (scenario === 'resolved') {
      event('serverRequest/resolved', { threadId: root, requestId: 100 });
      complete();
    }
    if (scenario === 'child-ended') setTimeout(() => complete(), 100);
    if (scenario === 'multiple') out({ id: 101, method: 'item/commandExecution/requestApproval', params: { threadId: root, turnId: current.id, itemId: 'approval' } });
    return;
  }
  if (value.method === 'turn/interrupt') {
    reply(value.id, {});
    return complete('interrupted');
  }
  if (value.method === 'thread/delete') return reply(value.id, {});
});
