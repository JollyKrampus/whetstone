import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ToolError } from '../core/errors.js';

export { ToolError };

export function ok(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function fail(error: string, details?: unknown): CallToolResult {
  const body = { error, details: details ?? null };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
  };
}

/** Wraps a tool handler so every failure comes back as `{ error, details }` instead of a throw. */
export function guarded<A>(fn: (args: A) => Promise<unknown> | unknown) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return ok(await fn(args));
    } catch (err) {
      if (err instanceof ToolError) return fail(err.message, err.details);
      const message = err instanceof Error ? err.message : String(err);
      return fail('internal_error', { message });
    }
  };
}
