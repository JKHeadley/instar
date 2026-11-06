/**
 * The Tailscale setup recipe (docs/specs/recommended-services.md, First recipes: Tailscale).
 *
 * The person's only part is one tap on Tailscale's sign-in link. The check passes only when this
 * machine is signed in and online, and its words never carry an address, device or account name.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RECOMMENDED_SERVICE_CATALOG } from '../../src/recommended/catalog.js';
import {
  SETUP_RECIPES,
  catalogWithProving,
  judgeTailscaleStatus,
  readTailscaleStatus,
  recipeFor,
  type TailscaleStatusRead,
} from '../../src/recommended/recipes.js';
import { loadCapturedFixture } from '../helpers/loadCapturedFixture.js';

const recipe = SETUP_RECIPES.find((r) => r.id === 'tailscale-v1')!;
const signedIn = loadCapturedFixture('tailscale-status', 'status-full');
const signedOut = loadCapturedFixture('tailscale-status', 'status-needslogin');
const verifyWith = (read: TailscaleStatusRead) => recipe.verify({ readSecret: () => null, tailscaleStatus: async () => read });

describe('Tailscale recipe: the check', () => {
  it('passes on the REAL captured status of a signed-in machine, and says nothing identifying', () => {
    const out = judgeTailscaleStatus(signedIn);
    expect(out.result).toBe('pass');
    // The fixture keeps address-, tailnet- and host-shaped placeholders; none may reach the words.
    expect(out.detail).not.toMatch(/100\.|fd7a|ts\.net|xxxx|@/);
  });

  it('fails on the REAL captured status of a never-signed-in machine', () => {
    const out = judgeTailscaleStatus(signedOut);
    expect(out).toEqual({ result: 'fail', detail: 'This machine is not signed in to Tailscale yet.' });
  });

  it('fails every other state that is not a working connection', () => {
    expect(judgeTailscaleStatus(JSON.stringify({ BackendState: 'NeedsMachineAuth' })).detail).toContain('administrator');
    expect(judgeTailscaleStatus(JSON.stringify({ BackendState: 'Stopped' })).detail).toContain('switched off');
    expect(judgeTailscaleStatus(JSON.stringify({ BackendState: 'Starting' })).result).toBe('fail');
    expect(judgeTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: [] } })).result).toBe('fail');
    expect(judgeTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { Online: false, TailscaleIPs: ['100.1.2.3'] } })).result).toBe('fail');
  });

  it('never passes an answer it cannot read', () => {
    expect(judgeTailscaleStatus('not json').result).toBe('unknown');
    expect(judgeTailscaleStatus('{"Self":{}}').result).toBe('unknown');
    expect(judgeTailscaleStatus('null').result).toBe('unknown');
  });

  it('a missing or stopped program is a fail, so setup starts; a hung one is unknown, so nothing starts', async () => {
    expect((await verifyWith({ kind: 'missing' })).result).toBe('fail');
    expect((await verifyWith({ kind: 'failed' })).result).toBe('fail');
    expect((await verifyWith({ kind: 'timeout' })).result).toBe('unknown');
    expect((await verifyWith({ kind: 'ok', stdout: signedIn })).result).toBe('pass');
    expect((await verifyWith({ kind: 'ok', stdout: signedOut })).result).toBe('fail');
  });
});

describe('Tailscale recipe: reading the program', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'ts-read-'));
  const program = (name: string, body: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };

  it('no program anywhere reads as missing', async () => {
    expect(await readTailscaleStatus([path.join(dir, 'absent-1'), path.join(dir, 'absent-2')])).toEqual({ kind: 'missing' });
  });

  it('the first program that answers wins, so the one on PATH beats the app', async () => {
    const first = program('first', `echo '{"BackendState":"NeedsLogin"}'`);
    const second = program('second', `echo '{"BackendState":"Running"}'`);
    const out = await readTailscaleStatus([path.join(dir, 'absent'), first, second]);
    expect(out.kind).toBe('ok');
    expect(out.kind === 'ok' && JSON.parse(out.stdout).BackendState).toBe('NeedsLogin');
  });

  it('a state printed with a non-zero exit is still read', async () => {
    const out = await readTailscaleStatus([program('stopped', `echo '{"BackendState":"Stopped"}'; exit 1`)]);
    expect(out.kind === 'ok' && judgeTailscaleStatus(out.stdout).result).toBe('fail');
  });

  it('a program that only errors, such as with no daemon running, reads as failed', async () => {
    expect(await readTailscaleStatus([program('nodaemon', `echo 'failed to connect to local tailscaled' >&2; exit 1`)])).toEqual({ kind: 'failed' });
  });
});

describe('Tailscale recipe: the brief', () => {
  const brief = recipe.brief({ port: 4321 });

  it('is a proving recipe for the Tailscale row, and stores no secret', () => {
    expect(recipe.service).toBe('tailscale');
    expect(recipe.secretName).toBeNull();
    const row = catalogWithProving(['tailscale-v1'], () => true).find((r) => r.id === 'tailscale')!;
    expect(recipeFor(row)?.id).toBe('tailscale-v1');
    // Not available anywhere it isn't being proven.
    expect(RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === 'tailscale')!.setupRecipe).toBeNull();
    expect(catalogWithProving(['tailscale-v1'], () => false).find((r) => r.id === 'tailscale')!.setupRecipe).toBeNull();
  });

  it('covers the install check, the sign-in link, the status check and the Linux operator step', () => {
    expect(brief).toContain('tailscale status --json');
    expect(brief).toContain('If Tailscale isn\'t installed, install it yourself');
    expect(brief).toContain('https://login.tailscale.com/');
    expect(brief).toContain('sudo tailscale set --operator=<user>');
    expect(brief).toContain('http://localhost:4321/recommended-services/tailscale/verify');
  });

  it('keeps the person to one tap, and never signs in for them', () => {
    expect(brief).toContain('it is the one thing only they can do');
    expect(brief).toContain('Never sign in with an auth key, a stored credential, or a browser login you already hold');
    expect(brief).not.toMatch(/recommended-services\/tailscale\/key/);
  });

  it('never disturbs a machine that is already on a tailnet', () => {
    expect(brief).toContain('Never sign this machine out, switch it to another tailnet');
    expect(brief).toContain('call the check below and change nothing');
  });

  it('names the backup that needs no Tailscale', () => {
    expect(brief).toContain('Cloudflare, the local network, or messaging, which needs no address');
  });

  it('carries the shared rules exactly once', () => {
    expect(brief.match(/Rules that apply whatever you find:/g)).toHaveLength(1);
    expect(brief).toContain('/recommended-services/tailscale/hold');
  });

  it('never hands the person a step to follow', () => {
    expect(brief).not.toMatch(/ask (the person|them) to (run|install|open|type|visit|download)/i);
  });
});
