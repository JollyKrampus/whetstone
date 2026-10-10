import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export async function connect(server: McpServer) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'grindstone-test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  return { isError: Boolean(res.isError), body: res.structuredContent as Record<string, unknown> };
}
