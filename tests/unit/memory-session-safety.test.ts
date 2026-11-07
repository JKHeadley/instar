/** What a confined session can make the unsandboxed server do (docs/specs/memory-privacy.md). */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareSessionCurlHome, setAsideUnlessRealFolder } from '../../src/core/memorySessionPolicy.js';
import { isSafeSessionRef } from '../../src/core/claudeResumeTranscript.js';
import { TopicResumeMap } from '../../src/core/TopicResumeMap.js';
import { SessionManager } from '../../src/core/SessionManager.js';

const dirOf = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-safe-')));

describe('a session id reported by a hook', () => {
  it('passes only as a plain id', () => {
    for (const ok of ['7f1c2d3e-1111-4111-8111-111111111111', 'latest', '3', 'thread_abc-1']) expect(isSafeSessionRef(ok)).toBe(true);
    for (const bad of ['--plugin-dir=/x', '-x', '../../x', '/etc/passwd', 'a/b', 'a b', '', '.', '..', 'a.b', 'x'.repeat(129), 5, null, undefined]) {
      expect(isSafeSessionRef(bad)).toBe(false);
    }
  });

  it('is refused before it can be stored on a session', () => {
    const running = [{ id: 's1', tmuxSession: 't', claudeSessionId: 'old' }];
    const self = { state: { listSessions: () => running, saveSession: () => undefined } };
    SessionManager.prototype.setClaudeSessionId.call(self as never, 's1', '--plugin-dir=/x');
    expect(running[0].claudeSessionId).toBe('old');
  });

  it('is refused by the resume store, and a real id is kept', () => {
    const dir = dirOf();
    const map = new TopicResumeMap(dir, dir);
    const stored = () => fs.readFileSync(path.join(dir, 'topic-resume-map.json'), 'utf8');
    map.save(6, '7f1c2d3e-1111-4111-8111-111111111111', 'sess');
    map.save(5, '--plugin-dir=/../x', 'sess');
    expect(stored()).toContain('7f1c2d3e-1111-4111-8111-111111111111');
    expect(stored()).not.toContain('plugin-dir');
  });

  it('every resume flag in the launch code is guarded', () => {
    const count = (file: string, re: RegExp) => (fs.readFileSync(path.join(process.cwd(), file), 'utf8').match(re) ?? []).length;
    const flags = count('src/core/frameworkSessionLaunch.ts', /'--resume', options\.resumeSessionId/g);
    expect(flags).toBeGreaterThan(0);
    expect(count('src/core/frameworkSessionLaunch.ts', /isSafeSessionRef\(options\.resumeSessionId\)/g)).toBeGreaterThanOrEqual(flags + 1);
    expect(count('src/core/SessionManager.ts', /'--resume', options\.resumeSessionId/g)).toBe(count('src/core/SessionManager.ts', /isSafeSessionRef\(options\.resumeSessionId\)/g));
  });
});

describe('what the server writes into a folder a session controls', () => {
  it('.curlrc replaces a planted link and leaves its target alone', () => {
    const scope = dirOf();
    const victim = path.join(dirOf(), 'config.json');
    fs.writeFileSync(victim, 'owner config');
    fs.mkdirSync(path.join(scope, '.curl'));
    fs.symlinkSync(victim, path.join(scope, '.curl', '.curlrc'));
    const home = prepareSessionCurlHome(scope, 'linux')!;
    expect(fs.readFileSync(victim, 'utf8')).toBe('owner config');
    expect(fs.lstatSync(path.join(home, '.curlrc')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(home, '.curlrc'), 'utf8')).toContain('noproxy');
  });

  it('a linked .curl folder is set aside, and nothing is written through it', () => {
    const scope = dirOf();
    const elsewhere = dirOf();
    fs.symlinkSync(elsewhere, path.join(scope, '.curl'));
    expect(fs.lstatSync(prepareSessionCurlHome(scope, 'linux')!).isDirectory()).toBe(true);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('nothing is written on a Mac', () => {
    expect(prepareSessionCurlHome(dirOf(), 'darwin')).toBeNull();
  });

  it('a file where a folder belongs is moved aside, and a real folder stays', () => {
    const scope = dirOf();
    const asFile = path.join(scope, 'inbox');
    fs.writeFileSync(asFile, 'x');
    setAsideUnlessRealFolder(asFile);
    expect(fs.existsSync(asFile)).toBe(false);
    const real = path.join(scope, 'tmp');
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, 'keep'), 'y');
    setAsideUnlessRealFolder(real);
    expect(fs.readFileSync(path.join(real, 'keep'), 'utf8')).toBe('y');
    setAsideUnlessRealFolder(path.join(scope, 'absent'));
  });
});

describe('what a confined session feeds agent-wide', () => {
  it('a confined session never feeds digests; another does', () => {
    expect(SessionManager.prototype.feedsAgentDigests.call({} as never, { memoryScopeDir: '/scope' })).toBe(false);
    expect(SessionManager.prototype.feedsAgentDigests.call({} as never, { memoryScopeDir: undefined })).toBe(true);
  });
  it('the completion path applies the same rule as the periodic scan', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf8');
    const at = src.indexOf('activitySentinel!.synthesizeSession(session)');
    expect(at).toBeGreaterThan(-1);
    expect(src.lastIndexOf('feedsAgentDigests(session)', at)).toBeGreaterThan(at - 200);
  });
});

describe('a scoped session on the hook route', () => {
  it('names itself, whatever the address says', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/server/routes.ts'), 'utf8');
    expect(src).toContain("const instarSid = scopedSession ?? (typeof req.query.instar_sid === 'string'");
  });
  it('supplies no file paths', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/server/routes.ts'), 'utf8');
    expect(src).toContain("if (scopedSession) for (const field of ['transcript_path', 'agent_transcript_path', 'cwd'])");
  });
});
