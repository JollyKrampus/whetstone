import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION } from './version.js';
import { registerPing } from './tools/ping.js';

export function createServer(): McpServer {
  const server = new McpServer({ name: 'grindstone-mcp', version: VERSION });
  registerPing(server);
  return server;
}
