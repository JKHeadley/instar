/** Guard the prose a person reads. Source, link destinations and record metadata are separate. */
const INTERNAL_ID = /\b(?:wc_[0-9a-f]{8,}|(?:CMT|ACT|DF|SEC|PR)[- #]+\d+|DSE-T\d+|(?:topic|msg|message)\s+(?:id\s*)?#?\d{5,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const COMMIT_HASH = /\b(?=[0-9a-f]{7,64}\b)(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]+\b/gi;
const MARKDOWN_CODE = /`[^`\n]+`/;
const CODE_IDENTIFIER = /\b[a-z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b|\b[a-z][a-z0-9]+_[a-z][a-z0-9_]+\b/;
const INTERNAL_TERMS = /\b(?:handoff|constitution-check|local verify|stage\s+\d+\s*(?:gate|build)|exact[- ]head|token pacing|source[- ]binding|pickup hold|worktree)\b/i;
const STRUCTURAL_WORDS = new Set(['iPhone', 'iPad', 'iOS', 'macOS', 'GitHub', 'YouTube', 'TestFlight', 'OpenAI', 'ChatGPT', 'JavaScript', 'TypeScript', 'PowerPoint', 'GitLab', 'eBay', 'WhatsApp', 'Bitwarden']);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function workCardPlainLanguageIssue(
  fields: Record<string, unknown>,
  options: { preserveOriginalRequest?: boolean } = {},
): { field: string; message: string } | null {
  const lines: Array<[string, unknown]> = [
    ['title', fields.title], ['whyYou', fields.whyYou], ['recommendation', fields.recommendation],
  ];
  if (!options.preserveOriginalRequest) lines.push(['need', fields.need]);
  const addItems = (key: string, value: unknown, child: string) => {
    if (!Array.isArray(value)) return;
    value.forEach((item, i) => lines.push([`${key}[${i}].${child}`, record(item)[child]]));
  };
  addItems('doneWhen', fields.doneWhen, 'text');
  addItems('links', fields.links, 'label');
  const brief = record(fields.brief);
  for (const key of ['ask', 'goal', 'chiefSaid']) lines.push([`brief.${key}`, brief[key]]);
  addItems('brief.checks', brief.checks, 'text');

  for (const [field, value] of lines) {
    if (typeof value !== 'string') continue;
    const withoutNames = value.replace(/\b[A-Za-z][A-Za-z0-9]+\b/g, word => STRUCTURAL_WORDS.has(word) ? ' ' : word);
    if (INTERNAL_ID.test(withoutNames) || withoutNames.match(COMMIT_HASH) || MARKDOWN_CODE.test(withoutNames)
      || CODE_IDENTIFIER.test(withoutNames) || INTERNAL_TERMS.test(withoutNames)) {
      return {
        field,
        message: 'Rewrite this field in plain words. Say what the person will see, why it matters, and what approving would change. Keep internal references in the source or link address.',
      };
    }
  }
  return null;
}
