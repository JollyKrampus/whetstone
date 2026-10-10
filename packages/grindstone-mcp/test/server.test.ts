import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import { call, connect } from './helpers.js';

describe('server', () => {
  it('answers ping', async () => {
    const client = await connect(createServer());
    const { isError, body } = await call(client, 'ping');
    expect(isError).toBe(false);
    expect(body).toMatchObject({ ok: true, server: 'grindstone-mcp' });
  });
});
