/**
 * The second-AI-subscription recipe (docs/specs/recommended-services.md, catalog row second-ai-door): a second
 * provider signed in on this machine and switched on for this agent. Never signs a door in or out; switches a
 * door on or off for this agent only.
 */
import { describe, expect, it } from 'vitest';
import { RECOMMENDED_SERVICE_CATALOG } from '../../src/recommended/catalog.js';
import { catalogWithProving, recipeFor, type StopDeps, type SyncDeps } from '../../src/recommended/recipes.js';
import { mainDoor, secondDoorCandidates, withDoor, withoutDoor, type AiDoorSurface } from '../../src/recommended/aiDoors.js';
import type { SignedInVerdict } from '../../src/install/doors.js';
import type { InstallDoor } from '../../src/commands/setup-wizard/state-machine.js';

const row = RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === 'second-ai-door')!;
const recipe = recipeFor({ ...row, setupRecipe: 'second-door-v1' })!;

function doors(over: { enabled?: string[]; signed?: Partial<Record<InstallDoor, SignedInVerdict>>; installed?: InstallDoor[] } = {}) {
  const state = { enabled: over.enabled ?? ['claude-code'], signed: { 'claude-code': 'signed-in', 'codex-cli': 'signed-out', ...over.signed } as Record<InstallDoor, SignedInVerdict>, installed: over.installed ?? ['claude-code', 'codex-cli'] as InstallDoor[], added: [] as InstallDoor[] };
  const surface: AiDoorSurface = {
    enabled: () => [...state.enabled],
    installed: (d) => state.installed.includes(d),
    signedIn: async (d) => state.signed[d],
    enable: (d) => { const next = withDoor(state.enabled, d); if (!next) return false; state.enabled = next; state.added.push(d); return true; },
    disable: (d) => { if (!state.added.includes(d)) return false; state.enabled = withoutDoor(state.enabled, d); state.added = state.added.filter((x) => x !== d); return true; },
  };
  return { surface, state };
}
const verify = (s: AiDoorSurface) => recipe.verify({ readSecret: () => null, aiDoors: s });

describe('door lists', () => {
  it('the main door is the first switched-on one, Claude by default', () => {
    expect(mainDoor([])).toBe('claude-code');
    expect(mainDoor(['codex-cli', 'claude-code'])).toBe('codex-cli');
    expect(secondDoorCandidates(['claude-code'])).toEqual(['codex-cli']);
    expect(secondDoorCandidates(['codex-cli'])).toEqual(['claude-code']);
  });
  it('listing adds after the main door, changes nothing with no list (all allowed) or a door already listed; removing never drops the main door', () => {
    expect(withDoor(['claude-code'], 'codex-cli')).toEqual(['claude-code', 'codex-cli']);
    expect(withDoor([], 'codex-cli')).toBeNull();
    expect(withDoor(['claude-code', 'codex-cli'], 'codex-cli')).toBeNull();
    expect(withoutDoor(['claude-code', 'codex-cli'], 'codex-cli')).toEqual(['claude-code']);
    expect(withoutDoor(['claude-code', 'codex-cli'], 'claude-code')).toEqual(['claude-code', 'codex-cli']);
  });
});

describe('the second-door-v1 recipe', () => {
  it('is available on every agent after its live proof (2026-11-08)', () => {
    expect(row.setupRecipe).toBe('second-door-v1');
    expect(recipe.secretName).toBeNull();
    expect(recipeFor(catalogWithProving(['second-door-v1'], () => true).find((r) => r.id === 'second-ai-door')!)?.id).toBe('second-door-v1');
  });

  it('passes when a second provider is installed and signed in on this machine; absent when none is', async () => {
    expect((await verify(doors({ signed: { 'codex-cli': 'signed-in' } }).surface)).result).toBe('pass');
    expect(await verify(doors().surface)).toMatchObject({ result: 'fail', absent: true });
    expect(await verify(doors({ signed: { 'codex-cli': 'signed-in' }, installed: ['claude-code'] }).surface)).toMatchObject({ result: 'fail', absent: true });
    expect((await verify(doors({ signed: { 'codex-cli': 'unknown' } }).surface)).result).toBe('unknown');
    // The main door's own sign-in is not a second provider.
    expect((await verify(doors({ enabled: ['codex-cli'], signed: { 'codex-cli': 'signed-in', 'claude-code': 'signed-out' } }).surface)).absent).toBe(true);
    expect((await recipe.verify({ readSecret: () => null })).result).toBe('unknown');
  });

  it('the server lists a signed-in second door only where the agent lists providers, and says so', async () => {
    const none = doors();
    expect((await recipe.sync!({ readSecret: () => null, aiDoors: none.surface, secretNames: () => [] } as SyncDeps)).ok).toBe(false);
    expect(none.state.enabled).toEqual(['claude-code']);
    const listed = doors({ signed: { 'codex-cli': 'signed-in' } });
    const out = await recipe.sync!({ readSecret: () => null, aiDoors: listed.surface, secretNames: () => [] } as SyncDeps);
    expect(out).toMatchObject({ ok: true, copied: ['codex-cli'] });
    expect(out.detail).toContain('from the next restart');
    expect(listed.state.enabled).toEqual(['claude-code', 'codex-cli']);
    // Run again (the daily refresh): nothing changes.
    expect((await recipe.sync!({ readSecret: () => null, aiDoors: listed.surface, secretNames: () => [] } as SyncDeps)).detail).toContain('already allowed');
    const allAllowed = doors({ enabled: [], signed: { 'codex-cli': 'signed-in' } });
    await recipe.sync!({ readSecret: () => null, aiDoors: allAllowed.surface, secretNames: () => [] } as SyncDeps);
    expect(allAllowed.state.enabled).toEqual([]);
  });

  it('a switch-off takes back only the door setup listed, never the main one, never a sign-in', async () => {
    const d = doors({ signed: { 'codex-cli': 'signed-in' } });
    await recipe.sync!({ readSecret: () => null, aiDoors: d.surface, secretNames: () => [] } as SyncDeps);
    const stop = (setUpHere: boolean) => recipe.stop({ readSecret: () => null, deleteSecret: () => undefined, setUpHere, aiDoors: d.surface } as StopDeps);
    // Even when the sign-in was here before setup, the listing setup made is taken back.
    expect(await stop(false)).toMatchObject({ stopped: true, changed: true });
    expect(d.state.enabled).toEqual(['claude-code']);
    expect(await stop(true)).toMatchObject({ stopped: true, changed: false });
    expect(d.state.signed['codex-cli']).toBe('signed-in');
    // A door the person listed themselves is never taken out.
    const theirs = doors({ enabled: ['claude-code', 'codex-cli'], signed: { 'codex-cli': 'signed-in' } });
    expect(await recipe.stop({ readSecret: () => null, deleteSecret: () => undefined, setUpHere: true, aiDoors: theirs.surface } as StopDeps)).toMatchObject({ changed: false });
    expect(theirs.state.enabled).toEqual(['claude-code', 'codex-cli']);
  });

  it('the brief makes sign-in the person own tap, never signs out, and asks before anything is bought', () => {
    const brief = recipe.brief({ port: 4042 });
    expect(brief).toContain('codex login --device-auth');
    expect(brief).toContain('Never sign this machine out of a door');
    expect(brief).toContain('ask for their yes before anything is bought');
    expect(brief).toContain('/recommended-services/second-ai-door/sync');
  });
});
