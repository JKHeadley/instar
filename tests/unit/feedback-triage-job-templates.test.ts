/**
 * The feedback triage jobs gate on the triage route itself, so an agent where triage is dark
 * (the fleet: the route answers 503) never spawns a session every 15 minutes just to see a 503.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const DIR = path.resolve(__dirname, '../../src/scaffold/templates/jobs/instar');
const frontmatter = (file: string) => {
  const raw = fs.readFileSync(path.join(DIR, file), 'utf8');
  return yaml.load(raw.split('---')[1]) as Record<string, unknown>;
};

describe('feedback triage job templates', () => {
  for (const file of ['feedback-factory-triage.md', 'feedback-factory-action-list.md']) {
    it(`${file} gates on the authenticated triage summary route (skips when dark)`, () => {
      const fm = frontmatter(file);
      const gate = String(fm.gate);
      expect(gate).toContain('/feedback-factory/triage/summary');
      expect(gate).toContain('curl -sf');
      expect(gate).toContain('Authorization: Bearer $INSTAR_AUTH_TOKEN');
      expect(gate).toContain('X-Instar-AgentId: $INSTAR_AGENT_ID');
    });
  }
  it('the triage job runs every 15 minutes under tier-1 supervision; the action list at 08:00', () => {
    expect(frontmatter('feedback-factory-triage.md')).toMatchObject({ schedule: '*/15 * * * *', supervision: 'tier1' });
    expect(frontmatter('feedback-factory-action-list.md')).toMatchObject({ schedule: '0 8 * * *' });
  });
});
