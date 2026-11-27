/**
 * Vault-backed dashboard-PIN resolution (the 2026-06-06 topic-5 placeholder
 * leak: the dashboard broadcast sent a user `PIN: (check your config)` — the
 * internal placeholder — when the PIN failed to resolve at boot under host
 * pressure).
 *
 * Exercises resolveDashboardPinFromVault + pickDashboardPin against a REAL
 * SecretStore on disk: the happy path, every failure shape resolving to null
 * WITHOUT throwing, the in-memory-first preference, and the invariant that the
 * placeholder string is NEVER returned as a value. Vaults are written with
 * forceFileKey so tests never touch the real keychain; one test reads through
 * the production path (no forceFileKey) to prove the dual-key file-candidate
 * read (CMT-1038) covers it.
 */
import { describe, it, expect, beforeEach, afterEach,vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretStore } from '../../src/core/SecretStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  resolveDashboardPinFromVault,
  pickDashboardPin,
  DASHBOARD_PIN_PLACEHOLDER,
  DASHBOARD_PIN_VAULT_KEY,
  persistDashboardPin,
} from '../../src/core/dashboardPin.js';
import {LiveConfig} from '../../src/config/LiveConfig.js';
import {readConversationGraphOwnerPolicy} from '../../src/core/ConversationGraphOwnerPolicy.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashpin-')); });
afterEach(() => { vi.restoreAllMocks();SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/dashboard-pin-vault.test.ts' }); });

function writeVault(entries: Record<string, unknown>): void {
  const store = new SecretStore({ stateDir: dir, forceFileKey: true });
  for (const [k, v] of Object.entries(entries)) store.set(k, v);
}

describe('resolveDashboardPinFromVault', () => {
  it('resolves the dashboardPin from the vault', () => {
    writeVault({ [DASHBOARD_PIN_VAULT_KEY]: '481516' });
    expect(resolveDashboardPinFromVault(dir, { forceFileKey: true })).toBe('481516');
  });

  it('trims surrounding whitespace from the stored PIN', () => {
    writeVault({ [DASHBOARD_PIN_VAULT_KEY]: '  234812 \n' });
    expect(resolveDashboardPinFromVault(dir, { forceFileKey: true })).toBe('234812');
  });

  it('returns null when no vault exists', () => {
    expect(resolveDashboardPinFromVault(dir, { forceFileKey: true })).toBeNull();
  });

  it('returns null when the vault has secrets but no dashboard PIN', () => {
    writeVault({ 'telegram.token': 'tg-something' });
    expect(resolveDashboardPinFromVault(dir, { forceFileKey: true })).toBeNull();
  });

  it('returns null for an empty or whitespace-only stored value', () => {
    writeVault({ [DASHBOARD_PIN_VAULT_KEY]: '   ' });
    expect(resolveDashboardPinFromVault(dir, { forceFileKey: true })).toBeNull();
  });

  it('returns null for a non-string value at the key', () => {
    writeVault({ [DASHBOARD_PIN_VAULT_KEY]: { secret: true } });
    expect(resolveDashboardPinFromVault(dir, { forceFileKey: true })).toBeNull();
  });

  it('never returns the placeholder, even if the vault somehow stores it', () => {
    writeVault({ [DASHBOARD_PIN_VAULT_KEY]: DASHBOARD_PIN_PLACEHOLDER });
    expect(resolveDashboardPinFromVault(dir, { forceFileKey: true })).toBeNull();
  });

  it('returns null (never throws) when the vault file is corrupt', () => {
    writeVault({ [DASHBOARD_PIN_VAULT_KEY]: '999000' });
    const encPath = path.join(dir, 'secrets', 'config.secrets.enc');
    fs.writeFileSync(encPath, Buffer.from('not-an-encrypted-vault'));
    expect(() => resolveDashboardPinFromVault(dir, { forceFileKey: true })).not.toThrow();
    expect(resolveDashboardPinFromVault(dir, { forceFileKey: true })).toBeNull();
  });

  it('production path (no forceFileKey) reads a file-keyed vault via the dual-key candidates', () => {
    writeVault({ [DASHBOARD_PIN_VAULT_KEY]: '707070' });
    expect(resolveDashboardPinFromVault(dir)).toBe('707070');
  });
});

describe('pickDashboardPin (in-memory first, vault fallback, never a placeholder)', () => {
  it('uses a usable in-memory PIN without reading the vault', () => {
    // No vault written — if it read the vault it would return null.
    expect(pickDashboardPin('135790', dir, { forceFileKey: true })).toBe('135790');
  });

  it('trims a usable in-memory PIN', () => {
    expect(pickDashboardPin('  642 \n', dir, { forceFileKey: true })).toBe('642');
  });

  it('falls back to the vault when the in-memory value is undefined', () => {
    writeVault({ [DASHBOARD_PIN_VAULT_KEY]: '246810' });
    expect(pickDashboardPin(undefined, dir, { forceFileKey: true })).toBe('246810');
  });

  it('falls back to the vault when the in-memory value is the unresolved {secret:true} object', () => {
    // The exact runtime shape that leaked: loadConfig failed to resolve the ref,
    // so the adapter holds the placeholder object instead of a string.
    writeVault({ [DASHBOARD_PIN_VAULT_KEY]: '864209' });
    expect(pickDashboardPin({ secret: true }, dir, { forceFileKey: true })).toBe('864209');
  });

  it('falls back to the vault when the in-memory value is the literal placeholder string', () => {
    writeVault({ [DASHBOARD_PIN_VAULT_KEY]: '112358' });
    expect(pickDashboardPin(DASHBOARD_PIN_PLACEHOLDER, dir, { forceFileKey: true })).toBe('112358');
  });

  it('returns null when neither in-memory nor vault yields a real PIN (caller omits the line)', () => {
    expect(pickDashboardPin(undefined, dir, { forceFileKey: true })).toBeNull();
    expect(pickDashboardPin({ secret: true }, dir, { forceFileKey: true })).toBeNull();
    expect(pickDashboardPin('', dir, { forceFileKey: true })).toBeNull();
  });

  it('NEVER returns the placeholder as a value under any input', () => {
    // in-memory placeholder + no vault → null, not the placeholder
    expect(pickDashboardPin(DASHBOARD_PIN_PLACEHOLDER, dir, { forceFileKey: true }))
      .not.toBe(DASHBOARD_PIN_PLACEHOLDER);
    // in-memory placeholder + vault also stores placeholder → still null
    writeVault({ [DASHBOARD_PIN_VAULT_KEY]: DASHBOARD_PIN_PLACEHOLDER });
    expect(pickDashboardPin(DASHBOARD_PIN_PLACEHOLDER, dir, { forceFileKey: true }))
      .not.toBe(DASHBOARD_PIN_PLACEHOLDER);
  });
});

describe('supported PIN writer reserves policy before vault mutation',()=>{
 function actual(){
  writeVault({dashboardPin:'private-A'});const file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify({dashboardPin:{secret:true}}));
  const live=new LiveConfig(dir);live.set('dashboardPin',{secret:true});const store=new SecretStore({stateDir:dir,forceFileKey:true});return{file,live,store};
 }
 it('confirms config reservation before opening/writing the vault, and flushes the actual vault before success',()=>{
  const f=actual(),events:string[]=[],initial=readConversationGraphOwnerPolicy({stateDir:dir,secrets:f.store})!;
  expect(persistDashboardPin(dir,'private-B',value=>{f.live.set('dashboardPin',value);events.push('config-confirmed');},()=>{
   events.push('vault-open');return{set:(key,value)=>{events.push('vault-write');f.store.set(key,value);},syncDurably:()=>{f.store.syncDurably();events.push('vault-durable');}};
  })).toBe('vault');
  expect(events).toEqual(['config-confirmed','vault-open','vault-write','vault-durable']);
  const policy=readConversationGraphOwnerPolicy({stateDir:dir,secrets:f.store})!;expect(policy.pin).toBe('private-B');expect(policy.generation).not.toBe(initial.generation);expect(JSON.parse(fs.readFileSync(f.file,'utf8')).dashboardPin).toEqual({secret:true});
 });
 it('never opens or mutates the vault when the actual generation reservation fails',()=>{
  const f=actual(),before=fs.readFileSync(f.file,'utf8'),rename=fs.renameSync,open=vi.fn(()=>f.store),set=vi.spyOn(f.store,'set');
  vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{if(String(to)===f.file)throw new Error('config reservation unavailable');return rename(from,to);});
  expect(()=>persistDashboardPin(dir,'private-B',value=>f.live.set('dashboardPin',value),open)).toThrow('config reservation unavailable');
  expect(open).not.toHaveBeenCalled();expect(set).not.toHaveBeenCalled();expect(f.store.get('dashboardPin')).toBe('private-A');expect(fs.readFileSync(f.file,'utf8')).toBe(before);
 });
 it('routes a vault flush failure through a second actual config generation, without claiming vault success',()=>{
  const f=actual(),generations:string[]=[];vi.spyOn(f.store,'syncDurably').mockImplementation(()=>{throw new Error('vault flush unavailable');});
  expect(persistDashboardPin(dir,'private-B',value=>{f.live.set('dashboardPin',value);generations.push(JSON.parse(fs.readFileSync(f.file,'utf8')).dashboardPinGeneration);},()=>f.store)).toBe('config');
  expect(generations).toHaveLength(2);expect(generations[0]).not.toBe(generations[1]);expect(JSON.parse(fs.readFileSync(f.file,'utf8')).dashboardPin).toBe('private-B');
 });
});
