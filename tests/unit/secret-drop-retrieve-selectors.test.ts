import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'secret-drop-selector-fixture-cleanup' }); });

describe('Secret Drop helper command selectors', () => {
  it('the printed selector survives the shell and retrieves unsafe and option-like names exactly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-selector-'));
    dirs.push(dir);
    const helper = path.resolve(__dirname, '../../src/templates/scripts/secret-drop-retrieve.mjs');
    const mock = path.join(dir, 'fetch.mjs');
    const values = { 'two words': 'synthetic-one', '--names': 'synthetic-two', '--browser': 'synthetic-three', '--consume': 'synthetic-four', '--run': 'synthetic-five', '--': 'synthetic-six', api_key: 'synthetic-seven' };
    fs.writeFileSync(mock, `globalThis.fetch = async () => ({ok:true,json:async()=>(${JSON.stringify({ values, origin: 'unverified' })})});`);
    const env = { ...process.env, INSTAR_AUTH_TOKEN: 'synthetic-test-key', INSTAR_PORT: '12345' };
    // sh receives only fixture paths and server-generated references. No secret is real.
    const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
    const base = `${quote(process.execPath)} --import ${quote(pathToFileURL(mock).href)} ${quote(helper)} fixture-token`;
    const listing = path.join(dir, 'listing');
    execFileSync('/bin/sh', ['-c', `${base} --names 2>${quote(listing)}`], { cwd: dir, env });
    const text = fs.readFileSync(listing, 'utf8');
    expect(text).toContain('unverified origin');
    for (const [i, value] of Object.values(values).entries()) {
      const reference = i < 6 ? `'#${i + 1}'` : 'api_key';
      expect(text).toContain(`  ${reference} (length `);
      expect(text).not.toContain(value);
      const output = execFileSync('/bin/sh', ['-c', `${base} ${reference}`], { cwd: dir, env, encoding: 'utf8' });
      expect(output).toBe(value);
    }
  });
});
