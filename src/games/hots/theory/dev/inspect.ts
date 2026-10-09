/**
 * Dev-only: shows what the extractor reads for some heroes, to debug a tag.
 *
 *   node src/games/hots/theory/dev/inspect.ts --hdp <heroes-data2 dir> --hero abathur,alarak
 *   node src/games/hots/theory/dev/inspect.ts --hdp <dir> --hero alarak --sentences "silenc"
 *
 * Without --sentences: every extracted tag with its evidence snippets. With --sentences <regex>:
 * each matching sentence as read (O), with own names masked (M) and after non-applying mentions
 * of crowd control were blanked (C).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { debugSentences, extractMechanics } from '../extract.ts';
import { heroInputsFromHeroesData, readHeroesData } from './fromHeroesData.ts';

function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { hdp: { type: 'string' }, hero: { type: 'string' }, sentences: { type: 'string' } },
  });
  if (!values.hdp) {
    console.error('Usage: node src/games/hots/theory/dev/inspect.ts --hdp <dir> [--hero a,b] [--sentences <regex>]');
    return 2;
  }
  const wanted = values.hero ? new Set(values.hero.split(',')) : null;
  const heroes = heroInputsFromHeroesData(readHeroesData(values.hdp)).filter((h) => !wanted || wanted.has(h.slug));
  for (const h of heroes) {
    console.log(`## ${h.slug} (${h.role})`);
    if (values.sentences) {
      const re = new RegExp(values.sentences, 'i');
      for (const s of debugSentences(h)) {
        if (re.test(s.original)) console.log(`${s.kind[0]}:${s.name}\n  O ${s.original}\n  M ${s.masked}\n  C ${s.clean}`);
      }
      continue;
    }
    for (const m of extractMechanics(h)) {
      console.log(`  ${m.tag}: ${m.evidence.map((e) => `${e.kind[0]}:${e.name} «${e.snippet}»`).join(' | ')}`);
    }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
