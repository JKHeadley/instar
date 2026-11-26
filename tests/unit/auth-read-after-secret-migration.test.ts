/**
 * ACT-1303 (reported by Luna/sagemind): once `instar pair` moves authToken
 * into the secret store, `.instar/config.json` holds `{ "secret": true }`.
 * The CLAUDE.md instruction every agent followed printed that placeholder,
 * so `curl -H "Authorization: Bearer $AUTH"` was rejected. The instruction
 * now reads the session env first, then the secret store, then the config
 * only when it holds a real string.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OLD_READ = `AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)`;

function authLines(md: string): string {
  return md.split('\n').filter((line) => line.startsWith('AUTH=')).slice(0, 2).join('\n');
}

/** Run the instruction's AUTH lines in `dir` with no session env and print AUTH. */
function resolveAuth(dir: string, lines: string): string {
  return execFileSync('bash', ['-c', `${lines}\nprintf '%s' "$AUTH"`], {
    cwd: dir, env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8',
  });
}

describe('API auth instruction after secret externalization', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-act1303-'));
    fs.mkdirSync(path.join(home, '.instar', 'scripts'), { recursive: true });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/auth-read-after-secret-migration.test.ts:afterEach' }));

  it('the generated CLAUDE.md no longer carries the placeholder-leaking read', () => {
    const md = generateClaudeMd('test-agent', 'Test Agent', 4042, false);
    expect(md).not.toContain(OLD_READ);
    expect(authLines(md)).toContain('INSTAR_AUTH_TOKEN');
    expect(authLines(md)).toContain('isinstance(v, str)');
  });

  it('a plain string token is still read when there is no session env or secret store', () => {
    fs.writeFileSync(path.join(home, '.instar', 'config.json'), JSON.stringify({ authToken: 'plain-token-123' }));
    const md = generateClaudeMd('test-agent', 'Test Agent', 4042, false);
    expect(resolveAuth(home, authLines(md))).toBe('plain-token-123');
  });

  it('a { secret: true } placeholder never becomes the Bearer value', () => {
    fs.writeFileSync(path.join(home, '.instar', 'config.json'), JSON.stringify({ authToken: { secret: true } }));
    const md = generateClaudeMd('test-agent', 'Test Agent', 4042, false);
    expect(resolveAuth(home, authLines(md))).toBe('');
    // The old instruction leaked the placeholder text.
    expect(resolveAuth(home, OLD_READ)).toContain('secret');
  });

  it('PostUpdateMigrator rewrites the old instruction in an existing CLAUDE.md, idempotently', () => {
    fs.writeFileSync(path.join(home, 'CLAUDE.md'), `# Agent\n\n\`\`\`bash\n${OLD_READ}\n\`\`\`\n`);
    const migrator = new PostUpdateMigrator({ projectDir: home, stateDir: path.join(home, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
    const run = () => {
      const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
      (migrator as unknown as { migrateClaudeMd(r: typeof result): void }).migrateClaudeMd(result);
      return result;
    };
    expect(run().upgraded).toContain('CLAUDE.md: API auth read survives secret externalization');
    const content = fs.readFileSync(path.join(home, 'CLAUDE.md'), 'utf8');
    expect(content).not.toContain(OLD_READ);
    expect(authLines(content)).toContain('INSTAR_AUTH_TOKEN');
    expect(run().upgraded).not.toContain('CLAUDE.md: API auth read survives secret externalization');
  });
});
