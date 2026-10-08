/** Thrown for problems the caller can fix (bad input, unknown format). No MCP dependency. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
