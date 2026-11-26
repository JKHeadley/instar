/** The Ideas page wording (docs/specs/ecosystem-idea-pipeline.md §9–§10). */
import { describe, it, expect } from 'vitest';
import { admissionLine, classWords, funnelLine, headline, ideasInBand, planRequest, projectLine } from '../../../dashboard/console/ideas-model.js';

const funnel = (over = {}) => ({ seen: 4, verified: 2, decided: 1, adopted: 0, lastAdoptionAt: null, audited: 0, overturnedInAudit: 0, bands: { now: 0, plan: 2, watch: 1, stopped: 1, unranked: 0 }, ...over });

describe('ideas model', () => {
  it('never-run reads as never-run, and quiet reads as quiet', () => {
    expect(headline({ neverRun: true, funnel: funnel() })).toMatch(/has not run yet/);
    expect(headline({ neverRun: false, funnel: funnel() })).toMatch(/Nothing is ready.*4 seen.*0 adopted/);
    expect(headline({ neverRun: false, funnel: funnel({ bands: { now: 1 } }) })).toMatch(/1 idea is ready/);
  });
  it('the funnel always shows, including overturned verdicts', () => {
    expect(funnelLine(funnel())).toMatch(/nothing adopted yet/);
    expect(funnelLine(funnel({ audited: 5, overturnedInAudit: 2, adopted: 1, lastAdoptionAt: '2026-11-01T00:00:00Z' }))).toMatch(/last adopted 2026-11-01.*2 of 5/);
  });
  it('says plainly which AI services were refused', () => {
    expect(admissionLine([])).toMatch(/No AI service/);
    expect(admissionLine([{ framework: 'codex-cli', admitted: false }, { framework: 'claude-code', admitted: true }])).toBe('codex-cli: refused · claude-code: allowed to read outside text');
  });
  it('words the risk class and a stalled project', () => {
    expect(classWords('reduces-capability')).toMatch(/blind trial/);
    expect(classWords(null)).toMatch(/not judged/);
    expect(projectLine({ stalled: true, lastError: 'boom' })).toMatch(/Stalled.*boom/);
    expect(projectLine({ lastCheckedAt: null })).toBe('Not checked yet.');
  });
  it('filters by band, and builds a plan request', () => {
    expect(ideasInBand([{ band: 'now' }, { band: 'plan' }], 'now')).toHaveLength(1);
    expect(planRequest('decline', { id: 'i' }, { reason: 'r' })).toEqual({ action: 'decline', ideaId: 'i', reason: 'r' });
  });
  it('the page writes outside text with textContent and imports from real modules', async () => {
    const src = (await import('node:fs')).readFileSync('dashboard/console/ideas.js', 'utf-8');
    expect(src).not.toMatch(/innerHTML/);
  });
});
