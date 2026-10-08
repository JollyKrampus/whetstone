import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Context, defaultContext } from './context.js';
import { VERSION } from './version.js';
import { registerPing } from './tools/ping.js';
import { registerAnalyzeTools } from './tools/analyzeTools.js';
import { registerDeckTools } from './tools/deckTools.js';
import { registerPowerTools } from './tools/powerTools.js';
import { registerSearch } from './tools/search.js';

export function createServer(ctx: Context = defaultContext()): McpServer {
  const server = new McpServer({ name: 'grindstone-mcp', version: VERSION });
  registerPing(server);
  registerSearch(server, ctx);
  registerDeckTools(server, ctx);
  registerAnalyzeTools(server, ctx);
  registerPowerTools(server, ctx);
  return server;
}
