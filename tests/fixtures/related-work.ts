import fs from 'node:fs';
import { reviewDigest } from '../../skills/spec-converge/scripts/related-work-preflight.mjs';

const sources = ['open-projects', 'open-specs', 'open-prs', 'recently-merged-prs', 'project-registry'];

export const relatedWorkSection = '\n\n## Related work\n\n```related-work-json\n' + JSON.stringify({
  observedAt: '2026-11-24T21:10:00Z',
  paths: ['src/probe.ts'],
  keywords: ['probe'],
  mergedLookbackHours: 48,
  sources: Object.fromEntries(sources.map((source) => [source, {
    coverage: 'checked', evidence: 'Fixture source read', locator: `evidence:fixture/${source}`,
    matchCount: 0, matches: [],
  }])),
}, null, 2) + '\n```\n';

export function writeReviewedRelatedWork(spec: string, report: string) {
  fs.appendFileSync(spec, relatedWorkSection);
  fs.writeFileSync(report, `# Convergence report\n\nrelated-work-review-sha256: ${reviewDigest(fs.readFileSync(spec, 'utf8'))}\n`);
}
