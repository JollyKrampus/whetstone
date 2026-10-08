import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION } from '../version.js';
import { guarded } from './result.js';

export function registerPing(server: McpServer) {
  server.registerTool(
    'ping',
    {
      title: 'Ping',
      description: 'Health check. Returns the server name and version.',
      inputSchema: {},
    },
    guarded(() => ({ ok: true, server: 'grindstone-mcp', version: VERSION })),
  );
}
