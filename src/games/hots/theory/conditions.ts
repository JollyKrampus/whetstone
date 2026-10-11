/**
 * Wording for reasons that only hold under a condition: a talent or one of several Heroics
 * (generated rule reasons) or a curator's `conditions` (curated reasons, Reason.conditions).
 * Dependency-free and browser-safe, so the pages and the draft island can render the same words
 * without importing the engine.
 */

/** "A", "A or B", "A, B or C". */
export function orList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/**
 * " Only when Blaze takes Nanomachine Coating (level 7)." for a reason with conditions (clauses
 * that read after "Only when", joined with ", and "), else "".
 */
export function conditionsText(conditions: readonly string[] | undefined): string {
  return conditions && conditions.length > 0 ? ` Only when ${conditions.join(', and ')}.` : '';
}

/** A reason's text with its conditions appended (" Only when …."), the way every list shows it. */
export function withConditions(reason: { text: string; conditions?: readonly string[] | undefined }): string {
  return `${reason.text}${conditionsText(reason.conditions)}`;
}
