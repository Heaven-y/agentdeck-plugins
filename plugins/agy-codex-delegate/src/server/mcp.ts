import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toolDefinitions } from '../runtime/tools';
import { request } from '../runtime/transport';

export async function serveMcp(directory: string) {
  const server = new Server({ name: 'agentdeck-codex-delegate', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));
  server.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
    try {
      const owner = call.params._meta?.['antigravity.google/conversation_id'];
      const value = await request(
        directory,
        'invoke',
        {
          name: call.params.name,
          arguments: call.params.arguments ?? {},
          // 原生 CLI 继承环境只在本机进程间传递，不进入工具参数、任务记录或页面。
          environment: process.env,
          ...(typeof owner === 'string' ? { owner } : {}),
        },
        { signal: extra.signal },
      );
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : '委派操作失败，请读取原任务' }],
      };
    }
  });
  await server.connect(new StdioServerTransport());
}
