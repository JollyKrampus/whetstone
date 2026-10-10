import { rulesText } from './cards.js';
import { tagRoles } from './roles.js';
import { saltRubric } from './rubric.js';
import type { CardRecord } from './types.js';

export interface SaltReport {
  /** Reasons this card is cut from (and never added to) the casual version. */
  avoid: string[];
  /** Reasons it is merely scored down, with the summed penalty. */
  penalize: string[];
  penalty: number;
}

let memo = new WeakMap<CardRecord, SaltReport>();
let compiled: { key: unknown; rules: { name: string; level: 'avoid' | 'penalize'; weight: number; re?: RegExp; role?: string }[] } | undefined;

/** How a casual table would feel about this card, per rubric/salt.json. */
export function saltOf(card: CardRecord): SaltReport {
  const rubric = saltRubric();
  if (compiled?.key !== rubric) {
    memo = new WeakMap();
    compiled = {
      key: rubric,
      rules: rubric.rules.map((r) => ({
        name: r.name,
        level: r.level,
        weight: r.weight ?? 0.1,
        ...(r.pattern ? { re: new RegExp(r.pattern) } : {}),
        ...(r.role ? { role: r.role } : {}),
      })),
    };
  }
  const hit = memo.get(card);
  if (hit) return hit;
  const text = rulesText(card);
  const roles = tagRoles(card).map((t) => t.role as string);
  const report: SaltReport = { avoid: [], penalize: [], penalty: 0 };
  const gc = rubric.gameChangers;
  if (card.gameChanger && gc.level !== 'ignore') {
    if (gc.level === 'avoid') report.avoid.push(gc.reason);
    else {
      report.penalize.push(gc.reason);
      report.penalty += gc.weight ?? 0.15;
    }
  }
  for (const r of compiled.rules) {
    const matches = (r.re && r.re.test(text)) || (r.role && roles.includes(r.role));
    if (!matches) continue;
    if (r.level === 'avoid') report.avoid.push(r.name);
    else {
      report.penalize.push(r.name);
      report.penalty += r.weight;
    }
  }
  memo.set(card, report);
  return report;
}
