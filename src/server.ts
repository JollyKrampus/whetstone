import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Context, defaultContext } from './context.js';
import { VERSION } from './version.js';
import { registerPing } from './tools/ping.js';
import { registerDeckTools } from './tools/deckTools.js';
import { registerSearch } from './tools/search.js';

export function createServer(ctx: Context = defaultContext()): McpServer {
  const server = new McpServer({ name: 'grindstone-mcp', version: VERSION });
  registerPing(server);
  registerSearch(server, ctx);
  registerDeckTools(server, ctx);
  return server;
}
