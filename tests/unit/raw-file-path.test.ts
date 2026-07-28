/**
 * detectRawFilePath — deterministic raw-file-path SIGNAL detector
 * (spec outbound-jargon-filepath-gap §2.3).
 *
 * The true/false table: paths shown as references MATCH; http(s):// URLs,
 * prose, and conceptual mentions do NOT. Plus the hard requirements:
 * ReDoS-bounded time on pathological input, bounded match echo (a secret
 * adjacent to a path never rides along), fail-safe empty handling.
 */

import { describe, it, expect } from 'vitest';
import { detectRawFilePath } from '../../src/core/raw-file-path.js';

describe('detectRawFilePath — true table (literal paths match)', () => {
  const positives: Array<[string, string]> = [
    ['absolute user path', 'the file lives at /Users/justin/projects/foo.txt for now'],
    ['home-relative path', 'edit ~/.config/foo/settings.json to change it'],
    ['.instar dot-dir path', 'check .instar/config.json for the port'],
    ['.claude dot-dir path', 'the hook is .claude/hooks/guard.sh'],
    ['repo-relative src path', 'I changed src/core/SessionManager.ts today'],
    ['repo-relative logs path', 'errors are in logs/server.log'],
    ['docs path', 'see docs/specs/foo-spec.md for details'],
    ['tmp path', 'wrote the report to /tmp/report/out.md'],
    ['backticked path still matches', 'check `.instar/config.json` for the value'],
  ];
  for (const [label, text] of positives) {
    it(`matches: ${label}`, () => {
      expect(detectRawFilePath(text).detected).toBe(true);
    });
  }
});

describe('detectRawFilePath — false table (legitimate forms stay legal)', () => {
  const negatives: Array<[string, string]> = [
    ['plain prose', 'I fixed the config file and restarted the server'],
    ['https URL with path', 'open https://example.com/docs/getting-started to read more'],
    ['http URL with deep path', 'see http://github.com/foo/src/core/Bar.ts for the source'],
    ['tunnel URL', 'your dashboard: https://echo.dawn-tunnel.dev/dashboard?tab=files'],
    ['and/or prose', 'we can do this and/or that, either/or works'],
    ['TCP/IP style', 'the TCP/IP stack handles it'],
    ['fraction-ish text', 'progress is at 3/4 of the total'],
    ['single bare slash segment', 'the route is /health and nothing else'],
    ['empty string', ''],
    ['conceptual mention', 'the source directory holds the TypeScript files'],
    ['no-slash text', 'nothing path-like here at all'],
  ];
  for (const [label, text] of negatives) {
    it(`passes: ${label}`, () => {
      expect(detectRawFilePath(text).detected).toBe(false);
    });
  }
});

describe('detectRawFilePath — hard requirements', () => {
  it('bounded match echo: stops at ? so an adjacent secret never rides along', () => {
    const r = detectRawFilePath('grab /Users/justin/secrets/foo.env?token=SUPERSECRET123 now');
    expect(r.detected).toBe(true);
    expect(r.match).toBeDefined();
    expect(r.match).not.toContain('token=');
    expect(r.match).not.toContain('SUPERSECRET123');
  });

  it('match echo is truncated to 120 chars', () => {
    const longPath = '/Users/justin/' + 'a'.repeat(60) + '/' + 'b'.repeat(60) + '/' + 'c'.repeat(60);
    const r = detectRawFilePath(`see ${longPath} here`);
    expect(r.detected).toBe(true);
    expect((r.match ?? '').length).toBeLessThanOrEqual(120);
  });

  it('ReDoS: 4KB pathological input completes in bounded time', () => {
    // Repeated slash-dot soup designed to stress backtracking engines.
    const pathological = ('/.a' + 'a/.'.repeat(8)).repeat(160).slice(0, 4096);
    const start = Date.now();
    detectRawFilePath(pathological);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500); // linear scan: typically <5ms
  });

  it('word boundary: an alphanumeric prefix never turns into a repo-relative match', () => {
    expect(detectRawFilePath('the missrc/foo thing is not a path').detected).toBe(false);
    expect(detectRawFilePath('RandomLogs/x.txt is not a known repo dir').detected).toBe(false);
  });

  it('repo-relative match works at string start', () => {
    expect(detectRawFilePath('src/core/Foo.ts changed').detected).toBe(true);
  });

  it('non-string input is handled fail-safe', () => {
    expect(detectRawFilePath(undefined as unknown as string).detected).toBe(false);
    expect(detectRawFilePath(null as unknown as string).detected).toBe(false);
  });
});
