import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as core from '../src/core/index.js';
import { bundledRubrics, constructedRubric, setRubricSource } from '../src/core/rubric.js';
import { fileRubricSource } from '../src/data/rubricFiles.js';

afterEach(() => setRubricSource(bundledRubrics));

describe('grindstone-mcp/core', () => {
  it('exposes the deck math without any Node or MCP imports', () => {
    for (const name of ['parseArenaText', 'resolveDeck', 'validateDeck', 'analyzeDeck', 'ratePower', 'suggestUpgrades', 'simulateHands', 'aggregateCards', 'parseRules', 'CardIndex', 'ToolError']) {
      expect(core).toHaveProperty(name);
    }
    const src = path.join(import.meta.dirname, '..', 'src', 'core');
    for (const file of ['index.ts', 'cards.ts', 'aggregate.ts', 'rubric.ts', 'meta.ts', 'rules.ts', 'roles.ts', 'errors.ts']) {
      const text = readFileSync(path.join(src, file), 'utf8');
      expect(text, file).not.toMatch(/from ['"](node:|@modelcontextprotocol|\.\.\/data\/|\.\.\/tools\/)/);
    }
  });

  it('uses <config dir>/rubric overrides, reading each file once', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'grindstone-rubric-'));
    mkdirSync(path.join(dir, 'rubric'));
    const custom = { ...JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'rubric', 'power-rubric.json'), 'utf8')), name: 'Custom' };
    const file = path.join(dir, 'rubric', 'power-rubric.json');
    writeFileSync(file, JSON.stringify(custom));
    setRubricSource(fileRubricSource(dir));
    expect(constructedRubric().name).toBe('Custom');
    writeFileSync(file, '{ not json');
    expect(constructedRubric().name).toBe('Custom');
    setRubricSource(fileRubricSource(mkdtempSync(path.join(os.tmpdir(), 'grindstone-empty-'))));
    expect(constructedRubric().name).toBe('Constructed (60-card)');
  });
});
