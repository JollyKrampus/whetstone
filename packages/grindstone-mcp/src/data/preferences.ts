import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Personal defaults in `<config dir>/preferences.json`; tool arguments always win. */
const preferencesSchema = z.object({
  /** Lean toward mythics, rares and pricier cards whenever there's a choice. */
  preferPremium: z.boolean().optional(),
});

export type Preferences = z.infer<typeof preferencesSchema>;

export function loadPreferences(configDir: string): Preferences {
  const file = path.join(configDir, 'preferences.json');
  if (!existsSync(file)) return {};
  const parsed = preferencesSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`Invalid preferences ${file}: ${parsed.error.message}`);
  return parsed.data;
}
