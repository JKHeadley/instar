import { parseDesignStandard } from '../../src/designGate/standardParser.js';

/**
 * The live design standard trimmed to the rules a test's own feedback entries earned.
 *
 * Tests that check feedback-entry structure pass a fixed set of entries. The live
 * standard keeps gaining rules earned from newer entries, which those tests do not
 * pass, so every new entry would otherwise fail them with `earned-entry-missing`.
 * This keeps the tests about the code: rules earned only from other entries, and
 * their rows in the machine-checkable summary, are removed, and so are changelog rows that cite
 * only other entries. Rules with no earned
 * provenance, and rules earned from any kept entry, stay exactly as written.
 */
export function designStandardForEntries(standard: string, keep: readonly string[]): string {
  const drop = parseDesignStandard(standard).rules
    .filter(rule => rule.earnedFrom.length > 0 && !rule.earnedFrom.some(entry => keep.includes(entry)))
    .map(rule => rule.id);
  let out = standard;
  for (const id of drop) {
    out = out.replace(new RegExp(`^### ${id} ·[\\s\\S]*?(?=^#{2,3} )`, 'm'), '');
    out = out.replace(new RegExp(`^\\| \`${id}\` \\|.*\\n`, 'm'), '');
  }
  // Changelog rows that cite only other entries go too, so a test's history checks see only its own rows.
  out = out.replace(/^\| \d{4}-\d{2}-\d{2} \|.*\|\s*([^|\n]*)\|\s*$\n?/gm, (row, source: string) => {
    const cited = source.match(/\bDF-\d{4,}\b/g) ?? [];
    return cited.length > 0 && !cited.some(entry => keep.includes(entry)) ? '' : row;
  });
  return out;
}

/** The rule-id lock trimmed to the ids still present in a trimmed standard, so no kept test sees a removed rule. */
export function designRuleLockForStandard(lockJson: string, standard: string): string {
  const lock = JSON.parse(lockJson) as { version: number; ids: string[] };
  const present = new Set(parseDesignStandard(standard).rules.map(rule => rule.id));
  return JSON.stringify({ ...lock, ids: lock.ids.filter(id => present.has(id)) }, null, 2) + '\n';
}
