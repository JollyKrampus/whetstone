/*
 * grindstone-mcp/core: the deterministic deck math with no Node built-ins, no MCP SDK and
 * no file or network access. Safe to bundle for browsers, workers and CI scripts.
 * Callers supply the card records (CardIndex), meta lists and, optionally, rubric JSON.
 */
export * from './types.js';
export * from './errors.js';
export * from './cards.js';
export * from './aggregate.js';
export * from './parse.js';
export * from './deck.js';
export * from './formats.js';
export * from './validate.js';
export * from './roles.js';
export * from './rubric.js';
export * from './analyze.js';
export * from './simulate.js';
export * from './power.js';
export * from './wildcards.js';
export * from './themes.js';
export * from './recs.js';
export * from './meta.js';
export * from './suggest.js';
export * from './search.js';
export * from './rules.js';
