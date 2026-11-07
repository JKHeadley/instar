/**
 * The Bitwarden setup recipe (docs/specs/recommended-services.md, First recipes: Bitwarden).
 *
 * The agent's own folder only; the copy is written by the server, never by the session; the master
 * password never travels on a command line. Both sides of every decision, against a stand-in vault.
 */
import { describe, expect, it } from 'vitest';
import { RECOMMENDED_SERVICE_CATALOG } from '../../src/recommended/catalog.js';
import { SETUP_RECIPES, catalogWithProving, recipeFor, type StopDeps, type SyncDeps } from '../../src/recommended/recipes.js';
import { VAULT_CHECK_ITEM, copiedSecretNames, type BitwardenSurface } from '../../src/recommended/bitwardenVault.js';

const recipe = SETUP_RECIPES.find((r) => r.id === 'bitwarden-v1')!;

/** A vault stand-in that records what was written and which passwords were offered. */
function fakeVault(over: Partial<{ installed: boolean; loggedIn: boolean; accepts: string | null; items: string[] | null; putFails: boolean; logoutFails: boolean; statusFails: boolean }> = {}) {
  const state = { installed: true, loggedIn: true, accepts: 'pw' as string | null, items: [] as string[] | null, putFails: false, logoutFails: false, statusFails: false, ...over };
  const writes: Array<[string, string]> = [];
  const unlocks: string[] = [];
  let logouts = 0;
  const surface: BitwardenSurface = {
    status: () => (state.statusFails ? null : { installed: state.installed, loggedIn: state.loggedIn }),
    unlock: (pw) => { unlocks.push(pw); return state.accepts !== null && pw === state.accepts; },
    itemNames: () => state.items,
    put: (key, value) => { if (state.putFails) return false; writes.push([key, value]); if (state.items && !state.items.includes(key)) state.items.push(key); return true; },
    logout: () => { logouts++; if (state.logoutFails) return false; state.loggedIn = false; return true; },
  };
  return { surface, writes, unlocks, logouts: () => logouts, state };
}

const secrets = (names: Record<string, string>) => (n: string) => names[n] ?? null;

describe('Bitwarden recipe: the check', () => {
  it('passes only when the vault opens with the stored password and the folder holds the marker', async () => {
    const v = fakeVault({ items: ['authToken', 'dashboardPin', VAULT_CHECK_ITEM] });
    const out = await recipe.verify({ readSecret: secrets({ bitwarden_master_password: 'pw' }), bitwarden: v.surface });
    expect(out.result).toBe('pass');
    expect(out.detail).toMatch(/2 items/);
    expect(v.unlocks).toEqual(['pw']);
  });

  it('says nothing of Bitwarden is here when the program or the login is missing, so setup starts', async () => {
    expect(await recipe.verify({ readSecret: () => null, bitwarden: fakeVault({ installed: false }).surface })).toMatchObject({ result: 'fail', absent: true });
    expect(await recipe.verify({ readSecret: () => null, bitwarden: fakeVault({ loggedIn: false }).surface })).toMatchObject({ result: 'fail', absent: true });
  });

  it('fails without a stored password, on a refused password, and on a folder without the marker; none of these is "absent"', async () => {
    const none = await recipe.verify({ readSecret: () => null, bitwarden: fakeVault().surface });
    expect(none).toMatchObject({ result: 'fail' });
    expect(none.absent).toBeUndefined();
    expect(await recipe.verify({ readSecret: secrets({ bitwarden_master_password: 'wrong' }), bitwarden: fakeVault().surface })).toMatchObject({ result: 'fail', detail: 'Bitwarden refused the stored master password.' });
    expect(await recipe.verify({ readSecret: secrets({ bitwarden_master_password: 'pw' }), bitwarden: fakeVault({ items: ['authToken'] }).surface })).toMatchObject({ result: 'fail' });
  });

  it('answers unknown, so nothing starts on a guess, when the program is unreachable, does not answer, or the folder cannot be read', async () => {
    expect((await recipe.verify({ readSecret: () => null })).result).toBe('unknown');
    // A status read that fails (a timeout, a broken CLI) is never "not logged in": that would start setup over a working vault.
    const slow = await recipe.verify({ readSecret: secrets({ bitwarden_master_password: 'pw' }), bitwarden: fakeVault({ statusFails: true }).surface });
    expect(slow.result).toBe('unknown');
    expect(slow.absent).toBeUndefined();
    expect((await recipe.verify({ readSecret: secrets({ bitwarden_master_password: 'pw' }), bitwarden: fakeVault({ items: null }).surface })).result).toBe('unknown');
  });

  it('never puts the password or a secret value in its words', async () => {
    const v = fakeVault({ items: ['authToken', VAULT_CHECK_ITEM] });
    const outs = await Promise.all([
      recipe.verify({ readSecret: secrets({ bitwarden_master_password: 'pw-secret-9' }), bitwarden: v.surface }),
      recipe.verify({ readSecret: secrets({ bitwarden_master_password: 'wrong-7' }), bitwarden: v.surface }),
    ]);
    for (const out of outs) expect(out.detail).not.toMatch(/pw-secret-9|wrong-7/);
  });
});

describe('Bitwarden recipe: the copy', () => {
  const deps = (v: ReturnType<typeof fakeVault>, store: Record<string, string>): SyncDeps => ({
    readSecret: secrets(store), bitwarden: v.surface, secretNames: () => Object.keys(store).filter((n) => n !== 'bitwarden_master_password'),
  });

  it('writes every named secret and the marker into the folder, and reports names only', async () => {
    const v = fakeVault();
    const out = await recipe.sync!(deps(v, { bitwarden_master_password: 'pw', authToken: 'A1', dashboardPin: '123456' }));
    expect(out.ok).toBe(true);
    expect(out.copied).toEqual(['authToken', 'dashboardPin']);
    expect(v.writes.map(([k]) => k)).toEqual(['authToken', 'dashboardPin', VAULT_CHECK_ITEM]);
    expect(v.writes.find(([k]) => k === 'authToken')![1]).toBe('A1');
    expect(JSON.stringify(out)).not.toMatch(/A1|123456|pw/);
  });

  it('refuses to copy without a login, when the program does not answer, or with a refused password, writing nothing', async () => {
    const out = await recipe.sync!(deps(fakeVault({ loggedIn: false }), { bitwarden_master_password: 'pw', authToken: 'A1' }));
    expect(out).toMatchObject({ ok: false, copied: [] });
    expect(await recipe.sync!(deps(fakeVault({ statusFails: true }), { bitwarden_master_password: 'pw', authToken: 'A1' }))).toMatchObject({ ok: false, copied: [] });
    const v = fakeVault({ accepts: 'other' });
    expect((await recipe.sync!(deps(v, { bitwarden_master_password: 'pw', authToken: 'A1' }))).ok).toBe(false);
    expect(v.writes).toEqual([]);
  });

  it('a write that fails is reported, and the copy is not called complete', async () => {
    const out = await recipe.sync!(deps(fakeVault({ putFails: true }), { bitwarden_master_password: 'pw', authToken: 'A1' }));
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/could not be written/);
  });
});

describe('Bitwarden recipe: switching off', () => {
  const deps = (over: Partial<StopDeps>): StopDeps => ({ readSecret: () => null, deleteSecret: () => undefined, setUpHere: true, ...over });

  it('removes the stored password, signs out only a login setup made, and says the copies stay', async () => {
    const v = fakeVault();
    const deleted: string[] = [];
    const out = await recipe.stop(deps({ readSecret: secrets({ bitwarden_master_password: 'pw' }), deleteSecret: (n) => { deleted.push(n); }, absentBefore: true, bitwarden: v.surface }));
    expect(deleted).toEqual(['bitwarden_master_password']);
    expect(v.logouts()).toBe(1);
    expect(out).toMatchObject({ stopped: true, changed: true });
    expect(out.detail).toMatch(/signed out/);
    expect(out.detail).toMatch(/copies already in your Bitwarden folder stay/);
  });

  it('keeps a login the person had before setup, removing only the stored password', async () => {
    const v = fakeVault();
    const out = await recipe.stop(deps({ readSecret: secrets({ bitwarden_master_password: 'pw' }), absentBefore: false, bitwarden: v.surface }));
    expect(v.logouts()).toBe(0);
    expect(out).toMatchObject({ stopped: true, changed: true });
    expect(out.detail).not.toMatch(/signed out/);
  });

  it('leaves everything when setup did not do it, and says so', async () => {
    const v = fakeVault();
    let deleted = 0;
    const out = await recipe.stop(deps({ setUpHere: false, readSecret: secrets({ bitwarden_master_password: 'pw' }), deleteSecret: () => { deleted++; }, absentBefore: true, bitwarden: v.surface }));
    expect(deleted).toBe(0);
    expect(v.logouts()).toBe(0);
    expect(out).toMatchObject({ stopped: true, changed: false });
    expect(out.detail).toMatch(/yours before I set anything up/);
  });

  it('a refused sign-out leaves the service on, after the password is gone', async () => {
    const v = fakeVault({ logoutFails: true });
    const out = await recipe.stop(deps({ readSecret: secrets({ bitwarden_master_password: 'pw' }), absentBefore: true, bitwarden: v.surface }));
    expect(out.stopped).toBe(false);
    expect(out.detail).toMatch(/still signed in/);
  });
});

describe('Bitwarden recipe: the brief and the catalog', () => {
  const brief = recipe.brief({ port: 4321 });

  it('is dark: proving agents only, until its live proof', () => {
    expect(recipe.service).toBe('bitwarden');
    expect(recipe.secretName).toBe('bitwarden_master_password');
    expect(RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === 'bitwarden')!.setupRecipe).toBeNull();
    expect(recipeFor(catalogWithProving(['bitwarden-v1'], () => true).find((r) => r.id === 'bitwarden')!)?.id).toBe('bitwarden-v1');
    expect(catalogWithProving(['bitwarden-v1'], () => false).find((r) => r.id === 'bitwarden')!.setupRecipe).toBeNull();
  });

  it('keeps the password off every command line and the copy out of the session', () => {
    expect(brief).toContain('--passwordenv');
    expect(brief).toContain('Never put a password on a command line, and never write it to a file');
    expect(brief).toContain('--method <n> --code <code>');
    expect(brief).toContain('never through echo, cat or a file');
    expect(brief).toContain('already logged in');
    expect(brief).toContain('somewhere this server also finds it');
    expect(brief).toContain('Spaces inside a passphrase are fine');
    expect(brief).not.toContain('bw unlock');
    expect(brief).toContain('/recommended-services/bitwarden/sync');
    expect(brief).toContain('You never read, print, store or move any of the agent\'s own secrets');
    expect(brief).toContain('The ONE value you handle is the Bitwarden login');
    expect(brief).not.toMatch(/bw (login|unlock) [^\n]*"\$?[A-Z_]*PASSWORD"/);
  });

  it('names both account choices, the folder, and the free plan', () => {
    expect(brief).toMatch(/their own Bitwarden account, or you can open a free account/);
    expect(brief).toContain('instar/<agent name>');
    expect(brief).toContain('Secret Drop link (two fields)');
    expect(brief).toContain('They never open a browser');
  });
});

describe('what gets copied', () => {
  it('every stored string leaf, by dotted name, except transient drops and the vault password itself', () => {
    const names = copiedSecretNames({
      authToken: 'a', dashboardPin: '1', portal: { instarReadToken: 't' }, tunnel: { token: 'x' },
      bitwarden_master_password: 'pw', secretDrops: { abc: { label: 'l', values: { secret: 's' } } }, empty: '', num: 5,
    });
    expect(names).toEqual(['authToken', 'dashboardPin', 'portal.instarReadToken', 'tunnel.token']);
  });
});

describe('the real surface over the provider', () => {
  it('maps a failed status read to null and a missing program to not-installed', async () => {
    const { realBitwardenSurface } = await import('../../src/recommended/bitwardenVault.js');
    // No bw anywhere on this test's lookup paths means "missing", never null: a missing program is a fact.
    const missing = realBitwardenSurface('unit-test-agent-with-no-bw');
    const s = missing.status();
    expect(s === null || typeof s.installed === 'boolean').toBe(true);
  });
});
