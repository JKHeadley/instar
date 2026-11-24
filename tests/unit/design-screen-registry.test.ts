import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { describe, expect, it } from 'vitest';
import { classifyDesignPaths, validateScreenRegistry, type ScreenRegistry } from '../../src/designGate/surfaceClassifier.js';
import { GROUPS, NATIVE_PAGES, NATIVE_PATHS, PHONE_ONLY_PAGES, PHONE_PAGE_ALIASES } from '../../dashboard/console/nav-model.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const registry = JSON.parse(read('docs/design/screens.json')) as ScreenRegistry;
const consoleSource = read('dashboard/console/console.js');
const consolePrefix = '/dashboard/console/';
const route = (hash: string) => `${consolePrefix}#/${hash}`;
/** Written, exact-path exceptions to the stage-2 operator-screen inventory.
 * No directory wildcard: every new outside-root HTML/CSS file needs explicit review.
 */
const outsideAssetExclusions: Record<string, { reason: string; evidence: string[] }> = {
  'console/prototype/example-output.html': {
    reason: 'Historical generated console design sample, explicitly not wired into or deployed with the product; README documents its live-data prototype generator.',
    evidence: ['console/prototype/README.md', 'console/prototype/build-console.py'],
  },
  'console/prototype/example-output-degraded.html': {
    reason: 'Degraded-data variant of the same historical generated console prototype, not a served operator entry point.',
    evidence: ['console/prototype/README.md', 'console/prototype/build-console.py'],
  },
  'console/prototype/example-output-slow.html': {
    reason: 'Slow-data variant of the same historical generated console prototype, not a served operator entry point.',
    evidence: ['console/prototype/README.md', 'console/prototype/build-console.py'],
  },
  'console/research/index.html': {
    reason: 'Research presentation of third-party mobile product images and findings, not an Instar operator application screen.',
    evidence: ['console/research/README.md'],
  },
  'console/research/desktop.html': {
    reason: 'Research presentation comparing third-party desktop interfaces, not a production console entry point.',
    evidence: ['console/research/README.md'],
  },
  'examples/project-apps/sales-pipeline.html': {
    reason: 'Worked custom-app source example documented by awareness; it is not mounted by repository production routes. An explicitly published copy executes through the separately registered project-app frame.',
    evidence: ['src/data/awareness/project-apps.md', 'src/server/projectAppSandboxRoutes.ts'],
  },
  'tests/fixtures/project-apps/hostile-app.html': {
    reason: 'Intentionally hostile sandbox security fixture whose comment requires every escape attempt to fail; not a product screen or acceptable design example.',
    evidence: ['tests/fixtures/project-apps/hostile-app.html'],
  },
  'site/src/styles/global.css': {
    reason: 'Tailwind input for the separately built instar.sh public marketing site, imported by its Astro layout; excluded from this operator-runtime registry, not declared non-UI or design-compliant.',
    evidence: ['site/src/layouts/Layout.astro', 'site/astro.config.mjs'],
  },
  'site/src/styles/starlight-custom.css': {
    reason: 'Theme input for the separately built instar.sh documentation site, explicitly mounted by Astro/Starlight customCss; excluded from this operator-runtime registry, not generated capture evidence.',
    evidence: ['site/astro.config.mjs'],
  },
};
const registeredPaths = new Set(registry.screens.flatMap(screen => [...screen.sources, ...screen.shared]));
function unclassifiedOutsideAssets(files: readonly string[]): string[] {
  return files.filter(file => /\.(?:html|css)$/.test(file) && !/^(?:dashboard|dashboard-pair)\//.test(file)
    && !registeredPaths.has(file) && !Object.hasOwn(outsideAssetExclusions, file)).sort();
}

function walk(dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const file = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(file) : [file];
  });
}

describe('draft screen inventory follows the actual shipped web entry points', () => {
  it('keeps extracted Accounts reads in every consuming console and legacy screen declaration', () => {
    const consumers = new Set(['dashboard/console/console.js', 'dashboard/console/needs-model.js', 'dashboard/index.html']);
    const affected = registry.screens.filter(screen => [...screen.sources, ...screen.shared].some(file => consumers.has(file)));
    expect(affected.some(screen => screen.id === 'console-capacity-accounts')).toBe(true);
    expect(affected.some(screen => screen.id === 'legacy-subscriptions')).toBe(true);
    for (const screen of affected) expect(screen.shared, screen.id).toContain('src/server/accountsReadRoutes.ts');
  });
  it('keeps surrounding read projections attached to every declared consuming screen', () => {
    const providers = [
      ['/mobile/browser-devices/status', 'src/server/browserStatusRead.ts'],
      ['/mobile/health-issues', 'src/server/mobileHealthRoutes.ts'],
      ['/work-board', 'src/server/workBoardRoutes.ts'],
      ['/health', 'src/server/healthBaseRead.ts'],
    ] as const;
    for (const [endpoint, provider] of providers) {
      const consumers = new Set([...walk('dashboard'), ...walk('dashboard-pair')]
        .filter(file => /\.(?:js|html)$/.test(file) && read(file).includes(endpoint)));
      const affected = registry.screens.filter(screen => [...screen.sources, ...screen.shared].some(file => consumers.has(file)));
      expect(affected.length, endpoint).toBeGreaterThan(0);
      for (const screen of affected) expect(screen.shared, `${screen.id}: ${provider}`).toContain(provider);
      const classified = classifyDesignPaths({ changedPaths: [provider], baseRegistry: registry });
      expect(classified.kind, provider).toBe('ui');
      expect(classified.screens).toEqual(affected.map(screen => screen.id).sort());
    }
  });
  it('uses valid literal existing sources and never invents seed or capture evidence', () => {
    expect(validateScreenRegistry(registry)).toEqual([]);
    expect(registry.screens.length).toBeGreaterThan(60);
    for (const screen of registry.screens) {
      expect(screen.surface).toBe('Web'); expect(screen.capture).toBe('uncaptured');
      expect(screen.trackedBy).toBe('CMT-2169'); expect(screen.seed).toBeUndefined();
      for (const file of [...screen.sources, ...screen.shared]) {
        expect(fs.statSync(path.join(root, file)).isFile(), `${screen.id}: ${file}`).toBe(true);
      }
    }
  });
  it('covers every real native dispatcher entry with its actual render module, including phone-only Pace', () => {
    const native = consoleSource.split('const NATIVE = {')[1].split('\n};')[0];
    const entries = [...native.matchAll(/'([^']+)'\s*:\s*(\w+)/g)];
    expect(entries.map(match => match[1]).sort()).toEqual([...NATIVE_PATHS].sort());
    for (const [, hash, render] of entries) {
      const screen = registry.screens.find(screen => screen.route === route(hash)); expect(screen, hash).toBeDefined();
      const imported = [...consoleSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)]
        .find(match => match[1].split(',').some(name => name.trim() === render));
      expect(imported, render).toBeDefined();
      const file = path.posix.normalize(`dashboard/console/${imported![2]}`);
      expect(screen!.sources, `${hash} uses ${render}`).toContain(file);
    }
    for (const hash of PHONE_ONLY_PAGES) expect(registry.screens.some(screen => screen.route === `${consolePrefix}?phone=1#/${hash}`)).toBe(true);
    expect(registry.screens.some(screen => screen.route === `${consolePrefix}?phone=1#/home`)).toBe(true);
    for (const hash of Object.values(PHONE_PAGE_ALIASES)) {
      expect(registry.screens.some(screen => screen.route === route(hash) || screen.route === `${consolePrefix}?phone=1#/${hash}`), String(hash)).toBe(true);
    }
  });
  it('covers section directories, the Agent door, and every native navigation destination including query states', () => {
    for (const group of GROUPS) expect(registry.screens.some(screen => screen.route === route(group.id)), group.id).toBe(true);
    expect(registry.screens.some(screen => screen.route === route('agent'))).toBe(true);
    for (const href of Object.values(NATIVE_PAGES)) {
      const destination = href.startsWith('#') ? `${consolePrefix}${href}` : href;
      expect(registry.screens.some(screen => screen.route === destination), destination).toBe(true);
    }
  });
  it('covers the actual legacy activation registry and visible tab buttons rather than a handwritten tab count', () => {
    const source = read('dashboard/index.html');
    const registryBody = source.split('const TAB_REGISTRY = [')[1].split('\n    ];')[0];
    const ids = [...registryBody.matchAll(/\bid:\s*'([^']+)'/g)].map(match => match[1]);
    const buttons = [...source.matchAll(/<button\b[^>]*data-tab="([^"]+)"/g)].map(match => match[1]);
    expect(ids.length).toBeGreaterThan(20); expect(new Set(ids)).toEqual(new Set(buttons));
    for (const id of ids) expect(registry.screens.some(screen => screen.route === `/dashboard/legacy?tab=${id}`), id).toBe(true);
  });
  it('registers every actual UI script, stylesheet, HTML page, image and font in dashboard and pairing roots', () => {
    const assets = [...walk('dashboard'), ...walk('dashboard-pair')].filter(file => /\.(?:html|css|js|png|woff2)$/.test(file));
    const result = classifyDesignPaths({ changedPaths: assets, baseRegistry: registry });
    expect(result.kind).toBe('ui'); expect(result.unregistered).toEqual([]);
  });
  it('covers repository-wide outside-root HTML/CSS with only precise written exceptions', () => {
    // Maintained source inventory includes newly added, untracked source files but
    // excludes gitignored installations/build outputs and private runtime state.
    const files = SafeGitExecutor.readSync(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.html', '*.css'], { cwd: root, operation: 'design-screen-registry:test-list-ui-assets' }).split('\0').filter(Boolean);
    expect(files).toContain('feedback-front/public/index.html');
    expect(unclassifiedOutsideAssets(files)).toEqual([]);
    for (const [file, exclusion] of Object.entries(outsideAssetExclusions)) {
      expect(files, file).toContain(file); expect(exclusion.reason.length).toBeGreaterThan(60);
      for (const evidence of exclusion.evidence) expect(fs.statSync(path.join(root, evidence)).isFile(), evidence).toBe(true);
    }
    const front = registry.screens.find(screen => screen.sources.includes('feedback-front/public/index.html'))!;
    expect(front).toBeDefined(); expect(front.route).toBe('/');
    expect(JSON.parse(read('feedback-front/vercel.json')).outputDirectory).toBe('public');
    expect(read('feedback-front/public/index.html')).toContain('Instar canonical feedback receiver front');
  });
  it('cannot silently accept a new HTML/CSS page outside the known UI roots or exception list', () => {
    const added = ['new-product/public/index.html', 'site/src/styles/new-component.css', 'console/prototype/new-page.html'];
    expect(unclassifiedOutsideAssets(added)).toEqual([...added].sort());
    // Even a new sibling of an excepted source needs its own justification.
    expect(unclassifiedOutsideAssets(['examples/project-apps/new-app.html'])).toEqual(['examples/project-apps/new-app.html']);
  });
  it('maps the separately served pairing assets to their actual dashboard-pair source directory', () => {
    const pair = registry.screens.find(screen => screen.route === '/dashboard/pair')!;
    expect(pair.sources).toEqual(expect.arrayContaining(['dashboard-pair/pair.html', 'dashboard-pair/pair.js', 'dashboard-pair/pair-model.js', 'dashboard-pair/pair.css', 'src/server/dashboardEntry.ts']));
    const service = registry.screens.find(screen => screen.route === '/dashboard/service-yes')!;
    expect(service.sources).toEqual(expect.arrayContaining(['dashboard-pair/service-yes.html', 'dashboard-pair/service-yes.js', 'dashboard-pair/pair.css']));
    const actualMount = read('src/server/dashboardEntry.ts');
    expect(actualMount).toContain("[PAIR_PAGE_PATH]: { file: 'pair.html'");
    expect(actualMount).toContain("'/dashboard/service-yes': { file: 'service-yes.html'");
  });
  it('registers every production TypeScript whole-page emitter with a written fixture-only exclusion', () => {
    // PasskeyWebAuthnFixture creates isolated RP proof pages for browser protocol tests,
    // not an operator product page; do not invent a product route or capture seed for it.
    const fixtureOnly = new Set(['src/core/PasskeyWebAuthnFixture.ts']);
    const emitters = walk('src').filter(file => file.endsWith('.ts') && /<!doctype\s+html\b|<html(?:\s|>)/i.test(read(file)));
    expect(emitters).toContain('src/server/documentPageRoutes.ts'); expect(emitters).toContain('src/recovery/RecoveryPhonePage.ts');
    for (const file of emitters.filter(file => !fixtureOnly.has(file))) {
      expect(classifyDesignPaths({ changedPaths: [file], baseRegistry: registry }).unregistered, file).toEqual([]);
    }
    expect(read('src/core/PasskeyWebAuthnFixture.ts')).toContain('switch (url.pathname)');
  });
  it('keeps trusted base coverage when a candidate removes or renames a registered source', () => {
    const accounts = registry.screens.find(screen => screen.route === route('capacity/accounts'))!;
    expect(accounts.sources).toContain('dashboard/console/accounts-model.js');
    expect(accounts.sources).toContain('src/server/mobileCapacityRoutes.ts');
    const candidate = { version: 1 as const, screens: registry.screens.filter(screen => screen.id !== accounts.id) };
    const result = classifyDesignPaths({ changedPaths: ['dashboard/console/accounts-model.js', 'src/server/mobileCapacityRoutes.ts'], baseRegistry: registry, candidateRegistry: candidate });
    expect(result.kind).toBe('ui'); expect(result.screens).toContain(accounts.id); expect(result.unregistered).toEqual([]);
  });
});
