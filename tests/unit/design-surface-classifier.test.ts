import { describe, expect, it } from 'vitest';
import { classifyDesignPaths, validateScreenRegistry, type ScreenRegistry } from '../../src/designGate/surfaceClassifier.js';
const registry: ScreenRegistry = { version: 1, screens: [{ id: 'accounts', surface: 'Web', title: 'Accounts', mainQuestion: 'Which account has capacity?', route: '/dashboard/console#/capacity/accounts', sources: ['dashboard/console/accounts.js', 'src/server/mobileCapacityRoutes.ts'], shared: ['dashboard/console/console.css'], capture: 'uncaptured', trackedBy: 'CMT-2169' }] };
const classify = (paths: string[], content: Record<string, string | null> = {}) => classifyDesignPaths({ changedPaths: paths, baseRegistry: registry, sourceText: content });

describe('design surface classification', () => {
  it('includes registered server sources even outside dashboard roots', () => {
    expect(classify(['src/server/mobileCapacityRoutes.ts'])).toMatchObject({ kind: 'ui', screens: ['accounts'], unregistered: [] });
  });
  it('treats any new UI-root asset as UI even when it is not registered', () => {
    expect(classify(['dashboard/console/new-page.js'])).toMatchObject({ kind: 'ui', unregistered: ['dashboard/console/new-page.js'] });
  });
  it('finds whole HTML renderers and HTML/CSS files outside known roots', () => {
    expect(classify(['src/new-view.ts'], { 'src/new-view.ts': 'export const render = () => `<!doctype html><html>Hi</html>`;' })).toMatchObject({ kind: 'ui', unregistered: ['src/new-view.ts'] });
    expect(classify(['src/pages/new.html'])).toMatchObject({ kind: 'ui' });
    expect(classify(['assets/new.css'])).toMatchObject({ kind: 'ui' });
  });
  it('distinguishes policy-only from non-UI code without requesting a browser', () => {
    expect(classify(['docs/DESIGN-STANDARD.md'])).toMatchObject({ kind: 'policy', screens: [] });
    expect(classify(['src/core/Math.ts'], { 'src/core/Math.ts': 'export const add = (a, b) => a + b;' })).toMatchObject({ kind: 'none', screens: [] });
  });
  it('does not let a candidate registry remove trusted base registration', () => {
    const candidate: ScreenRegistry = { version: 1, screens: [] };
    expect(classifyDesignPaths({ changedPaths: ['src/server/mobileCapacityRoutes.ts'], baseRegistry: registry, candidateRegistry: candidate })).toMatchObject({ kind: 'ui', screens: ['accounts'] });
  });
  it('permits a valid candidate to register a new UI source without hiding the base', () => {
    const candidate = structuredClone(registry);
    candidate.screens.push({ ...candidate.screens[0], id: 'new', route: '/dashboard/new', sources: ['dashboard/new.js'], shared: [] });
    expect(classifyDesignPaths({ changedPaths: ['dashboard/new.js'], baseRegistry: registry, candidateRegistry: candidate })).toMatchObject({ kind: 'ui', screens: ['new'], unregistered: [] });
  });
  it('excludes tests but never treats unreadable changed source as known non-UI', () => {
    expect(classify(['dashboard/console/new.test.js'])).toMatchObject({ kind: 'none' });
    expect(classify(['src/new-view.ts'], { 'src/new-view.ts': null })).toMatchObject({ kind: 'unreadable' });
  });
  it.each(['../dashboard/x.js', '/dashboard/x.js', 'C:\\dashboard\\x.js', 'dashboard/../x.js'])('rejects non-repository input %j', path => {
    expect(classify([path])).toMatchObject({ kind: 'unreadable' });
  });
  it('requires explicit tracked uncaptured status and unique identities', () => {
    expect(validateScreenRegistry(registry)).toEqual([]);
    const invalid = structuredClone(registry);
    invalid.screens[0].trackedBy = '';
    invalid.screens.push({ ...invalid.screens[0] });
    expect(validateScreenRegistry(invalid).map(e => e.code)).toEqual(expect.arrayContaining(['uncaptured-untracked', 'duplicate-screen', 'duplicate-route']));
  });
  it('rejects registration with traversal, missing sources or a captured screen without a seed', () => {
    const invalid = structuredClone(registry);
    invalid.screens[0].sources = ['../src/view.ts'];
    invalid.screens[0].capture = 'captured';
    expect(validateScreenRegistry(invalid).map(e => e.code)).toEqual(expect.arrayContaining(['invalid-source', 'missing-seed']));
  });
});


it('requires the title and the main question that a reviewer must judge', () => {
  const candidate = structuredClone(registry);
  candidate.screens[0].title = ''; candidate.screens[0].mainQuestion = '';
  expect(validateScreenRegistry(candidate).map(e => e.code)).toEqual(expect.arrayContaining(['missing-title', 'missing-main-question']));
});
