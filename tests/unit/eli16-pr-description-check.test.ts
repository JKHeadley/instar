/**
 * Unit tests — ELI16-on-every-PR gate (the pure check).
 *
 * The CI gate fails any PR whose DESCRIPTION lacks a plain-English ELI16 overview
 * (Justin's standard: the description is the review surface). Because the gate
 * blocks EVERY PR, the check must be exhaustively correct on both sides + honour
 * its exemptions — a false-fail would block the whole fleet's PRs.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs, no type declarations; runtime import is fine under vitest
import { checkPrDescriptionEli16, MIN_ELI16_DESCRIPTION_CHARS, resolvePrFields } from '../../scripts/eli16-pr-description-check.mjs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const longOverview =
  'In plain English: this change makes the widget read its config from the project ' +
  'directory instead of a temp folder, so agents that run in a sandbox can actually ' +
  'find it. Nothing about how you talk to your agent changes; it just stops a silent ' +
  'failure that only showed up for sandboxed runtimes.';

describe('checkPrDescriptionEli16', () => {
  it('PASSES when the body has an ## ELI16 heading with enough content', () => {
    const body = `## What\n\nSome change.\n\n## ELI16 — what this means\n\n${longOverview}\n\n## Tests\n\nAll pass.`;
    expect(checkPrDescriptionEli16({ body, title: 'fix(x): something', authorType: 'User' })).toEqual({ ok: true });
  });

  it('accepts ELI16 / ELI-16 / ELI 16 spellings, any heading level', () => {
    for (const h of ['## ELI16', '### ELI-16 overview', '# ELI 16 — plain english', '#### eli16']) {
      const body = `${h}\n\n${longOverview}`;
      expect(checkPrDescriptionEli16({ body, title: 't', authorType: 'User' }).ok).toBe(true);
    }
  });

  it('FAILS when the body has no ELI16 heading at all', () => {
    const body = `## What\n\nA change with a perfectly good description but no ELI16 section.\n\n## Tests\n\nPass.`;
    const r = checkPrDescriptionEli16({ body, title: 'feat(x): y', authorType: 'User' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-eli16-heading');
  });

  it('FAILS when the ELI16 section is present but too short (a one-liner)', () => {
    const body = `## ELI16\n\nIt fixes a bug.\n\n## Tests\n\nPass.`;
    const r = checkPrDescriptionEli16({ body, title: 'fix: z', authorType: 'User' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('eli16-too-short');
    expect(r.min).toBe(MIN_ELI16_DESCRIPTION_CHARS);
  });

  it('measures content only up to the NEXT heading (does not borrow other sections)', () => {
    // ELI16 section itself is short; the long content belongs to the next section.
    const body = `## ELI16\n\nShort.\n\n## What Changed\n\n${longOverview}`;
    expect(checkPrDescriptionEli16({ body, title: 't', authorType: 'User' }).ok).toBe(false);
  });

  it('ignores HTML comments when measuring the ELI16 content', () => {
    const body = `## ELI16\n\n<!-- ${'x'.repeat(500)} -->\n\nShort.`;
    expect(checkPrDescriptionEli16({ body, title: 't', authorType: 'User' }).ok).toBe(false);
  });

  it('EXEMPTS bot-authored PRs', () => {
    expect(checkPrDescriptionEli16({ body: '', title: 'Bump deps', authorType: 'Bot' })).toEqual({ ok: true, exempt: 'bot-author' });
  });

  it('EXEMPTS the automated release-cut PR', () => {
    expect(checkPrDescriptionEli16({ body: '', title: 'chore: release v1.3.300 [skip ci]', authorType: 'User' })).toEqual({ ok: true, exempt: 'release-cut' });
  });

  it('does NOT exempt a normal fix/feat PR just because the title mentions release', () => {
    const r = checkPrDescriptionEli16({ body: '## What\n\nx', title: 'feat: prep the release pipeline', authorType: 'User' });
    expect(r.ok).toBe(false);
  });

  it('handles null/empty body and title without throwing', () => {
    expect(checkPrDescriptionEli16({ body: null, title: null, authorType: null }).ok).toBe(false);
    expect(checkPrDescriptionEli16({}).ok).toBe(false);
  });
});

// EVO-026: a re-run of an old run must judge the PR's CURRENT title/body, never the
// body frozen in that run's event payload (PR #2059 stale-red incident, LRN-035).
describe('resolvePrFields — live PR over frozen payload', () => {
  const staleBody = '## What\n\nOld description with no overview.';
  const liveBody = `## ELI16 — plain words\n\n${longOverview}`;
  const baseEnv = {
    PR_BODY: staleBody, PR_TITLE: 'fix: old title', PR_AUTHOR_TYPE: 'User',
    PR_NUMBER: '42', GITHUB_REPOSITORY: 'owner/repo', GITHUB_TOKEN: 't0ken', GITHUB_ACTIONS: 'true',
  };
  const okFetch = (live: unknown) => async (url: string, init: any) => {
    expect(url).toBe('https://api.github.com/repos/owner/repo/pulls/42');
    expect(init.headers.Authorization).toBe('Bearer t0ken');
    return { ok: true, status: 200, json: async () => live } as any;
  };

  it('uses the live body when the payload body fails and the live one passes (source=api)', async () => {
    expect(checkPrDescriptionEli16({ body: staleBody, title: 'x', authorType: 'User' }).ok).toBe(false);
    const r = await resolvePrFields({
      env: baseEnv,
      fetchImpl: okFetch({ title: 'fix: new title', body: liveBody, user: { type: 'User' } }) as any,
    });
    expect(r.source).toBe('api');
    expect(r.pr).toEqual({ title: 'fix: new title', body: liveBody, authorType: 'User' });
    expect(checkPrDescriptionEli16(r.pr).ok).toBe(true);
  });

  it('the live read also wins in the other direction (body edited to drop the overview)', async () => {
    const r = await resolvePrFields({
      env: { ...baseEnv, PR_BODY: liveBody },
      fetchImpl: okFetch({ title: 't', body: staleBody, user: { type: 'User' } }) as any,
    });
    expect(r.source).toBe('api');
    expect(checkPrDescriptionEli16(r.pr).ok).toBe(false);
  });

  it('treats a null live body as empty and reads the live author type', async () => {
    const r = await resolvePrFields({ env: baseEnv, fetchImpl: okFetch({ title: 'Bump', body: null, user: { type: 'Bot' } }) as any });
    expect(r.pr).toEqual({ title: 'Bump', body: '', authorType: 'Bot' });
  });

  it('falls back to the payload on an HTTP error, a thrown fetch, or a malformed response', async () => {
    const http500 = await resolvePrFields({ env: baseEnv, fetchImpl: (async () => ({ ok: false, status: 500 })) as any });
    expect(http500.source).toBe('payload');
    expect(http500.fallbackReason).toBe('http-500');
    expect(http500.pr).toEqual({ body: staleBody, title: 'fix: old title', authorType: 'User' });

    const thrown = await resolvePrFields({ env: baseEnv, fetchImpl: (async () => { throw new Error('ECONNRESET'); }) as any });
    expect(thrown.source).toBe('payload');
    expect(thrown.fallbackReason).toContain('ECONNRESET');

    const malformed = await resolvePrFields({ env: baseEnv, fetchImpl: okFetch({ message: 'nope' }) as any });
    expect(malformed.source).toBe('payload');
  });

  it('falls back to the payload without calling fetch when the PR number or repo is missing', async () => {
    let called = false;
    const f = (async () => { called = true; return { ok: true }; }) as any;
    for (const env of [{ ...baseEnv, PR_NUMBER: undefined }, { ...baseEnv, GITHUB_REPOSITORY: '' }, { ...baseEnv, PR_NUMBER: '4;2' }, { ...baseEnv, GITHUB_ACTIONS: undefined }]) {
      const r = await resolvePrFields({ env, fetchImpl: f });
      expect(r.source).toBe('payload');
    }
    expect(called).toBe(false);
  });
});

describe('eli16-pr-description-check CLI — end to end against a local API', () => {
  const script = path.resolve(__dirname, '../../scripts/eli16-pr-description-check.mjs');
  const run = (env: Record<string, string>) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH ?? '', ...env } });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (code) => resolve({ code, out }));
    });

  it('passes and logs source=api when the stale payload fails but the live PR passes', async () => {
    const server = http.createServer((req, res) => {
      expect(req.url).toBe('/repos/owner/repo/pulls/7');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ title: 'fix: live', body: `## ELI16\n\n${longOverview}`, user: { type: 'User' } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;
    try {
      const r = await run({
        PR_BODY: 'no overview here', PR_TITLE: 'fix: stale', PR_AUTHOR_TYPE: 'User',
        PR_NUMBER: '7', GITHUB_REPOSITORY: 'owner/repo', GITHUB_TOKEN: 'x', GITHUB_ACTIONS: 'true',
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
      });
      expect(r.out).toContain('source=api');
      expect(r.code).toBe(0);
    } finally {
      server.close();
    }
  });

  it('judges the payload and logs source=payload when the API is unreachable', async () => {
    const r = await run({
      PR_BODY: 'no overview here', PR_TITLE: 'fix: stale', PR_AUTHOR_TYPE: 'User',
      PR_NUMBER: '7', GITHUB_REPOSITORY: 'owner/repo', GITHUB_ACTIONS: 'true', GITHUB_API_URL: 'http://127.0.0.1:1',
    });
    expect(r.out).toContain('source=payload');
    expect(r.code).toBe(1);
  });
});
