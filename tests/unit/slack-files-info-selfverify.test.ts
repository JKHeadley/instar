// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup only.
/**
 * files.info self-verify fix — roadmap 0.5 (slack-ai-employee-audit §1).
 *
 * Live defect: the startup self-verify probed files.info with the fabricated
 * id `F000SELFTEST`, expecting `file_not_found`. Slack rejects that id at
 * ARGUMENT VALIDATION instead (`invalid_arguments`), which the old
 * classification counted as an unexpected FAILURE — so a perfectly healthy
 * adapter logged `❌ files.info API: Unexpected error: … invalid_arguments`
 * at every boot (live server.log 2026-07-02 18:12:27).
 *
 * The fix: (a) probe with a WELL-FORMED synthetic id so a healthy workspace
 * answers the stronger `file_not_found`; (b) classify `invalid_arguments` as
 * what it actually proves — the endpoint, auth, and transport all answered —
 * so the check is robust to Slack-side validator drift in either direction.
 * `missing_scope` and unknown errors remain failures.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SlackAdapter,
  classifyFilesInfoSelfTest,
  FILES_INFO_PROBE_ID,
} from '../../src/messaging/slack/SlackAdapter.js';
import { SlackApiError } from '../../src/messaging/slack/SlackApiClient.js';

describe('classifyFilesInfoSelfTest — probe outcome classification', () => {
  it('passes on ok (unexpected success for a synthetic id)', () => {
    expect(classifyFilesInfoSelfTest(null).status).toBe('pass');
  });

  it('passes on file_not_found (probe id reached lookup)', () => {
    const r = classifyFilesInfoSelfTest('file_not_found');
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('file_not_found');
  });

  it('passes on invalid_arguments — the live 2026-07-02 regression', () => {
    // This is the exact shape the live server hit: Slack rejected the
    // synthetic probe id at argument validation. That proves the endpoint,
    // auth, and transport all answered — a responsive API, not a failure.
    const r = classifyFilesInfoSelfTest('invalid_arguments');
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('argument validation');
  });

  it('passes on invalid_arguments embedded in a full error message (non-SlackApiError path)', () => {
    expect(classifyFilesInfoSelfTest('Slack API files.info failed: invalid_arguments').status).toBe('pass');
  });

  it('fails on missing_scope (scope header lied)', () => {
    const r = classifyFilesInfoSelfTest('missing_scope');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('missing_scope');
  });

  it('fails on invalid_auth', () => {
    expect(classifyFilesInfoSelfTest('invalid_auth').status).toBe('fail');
  });

  it('fails on an unknown error', () => {
    const r = classifyFilesInfoSelfTest('fatal_error');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('fatal_error');
  });
});

describe('FILES_INFO_PROBE_ID — probe id shape', () => {
  it('is a well-formed Slack file id (F + uppercase alphanumerics), maximizing the chance of file_not_found over invalid_arguments', () => {
    expect(FILES_INFO_PROBE_ID).toMatch(/^F[A-Z0-9]{10,}$/);
    // And it is NOT the old malformed probe that tripped argument validation.
    expect(FILES_INFO_PROBE_ID).not.toBe('F000SELFTEST');
  });
});

describe('SlackAdapter._selfVerify — wiring (check 2 uses the classifier)', () => {
  const REQUIRED_SCOPES = [
    'files:read', 'channels:history', 'channels:read', 'chat:write',
    'im:history', 'im:read', 'im:write', 'users:read',
  ];

  let stateDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-slack-sv-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // auth.test (check 1: scope header) + files.slack.com (check 3: download).
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('auth.test')) {
        return {
          headers: new Headers({ 'x-oauth-scopes': REQUIRED_SCOPES.join(',') }),
        } as unknown as Response;
      }
      return {
        status: 302,
        headers: new Headers({ location: 'https://files-origin.slack.com/x' }),
      } as unknown as Response;
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function buildAdapter(filesInfoBehavior: 'ok' | string): { adapter: SlackAdapter; call: ReturnType<typeof vi.fn> } {
    const adapter = new SlackAdapter({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      authorizedUserIds: ['U_TEST'],
      workspaceMode: 'dedicated',
    } as any, stateDir);
    const call = vi.fn(async (method: string) => {
      if (method === 'files.info' && filesInfoBehavior !== 'ok') {
        throw new SlackApiError(
          `Slack API files.info failed: ${filesInfoBehavior}`,
          'files.info',
          filesInfoBehavior,
          false,
        );
      }
      return { ok: true };
    });
    (adapter as any).apiClient = { call };
    return { adapter, call };
  }

  function allOutput(): string {
    return [...logSpy.mock.calls, ...errorSpy.mock.calls].map(c => c.join(' ')).join('\n');
  }

  it('reports self-verification PASSED when files.info answers invalid_arguments (the live regression goes green)', async () => {
    const { adapter, call } = buildAdapter('invalid_arguments');
    await (adapter as any)._selfVerify();

    // The probe used the well-formed synthetic id.
    expect(call).toHaveBeenCalledWith('files.info', { file: FILES_INFO_PROBE_ID });
    const out = allOutput();
    expect(out).toContain('Self-verification passed');
    expect(out).not.toContain('❌ files.info API');
  });

  it('reports self-verification PASSED on file_not_found (healthy workspace)', async () => {
    const { adapter } = buildAdapter('file_not_found');
    await (adapter as any)._selfVerify();
    expect(allOutput()).toContain('Self-verification passed');
  });

  it('still FAILS the files.info check on missing_scope', async () => {
    const { adapter } = buildAdapter('missing_scope');
    await (adapter as any)._selfVerify();
    const out = allOutput();
    expect(out).toContain('❌ files.info API');
    expect(out).toContain('missing_scope');
  });

  it('still FAILS the files.info check on a genuinely unexpected error', async () => {
    const { adapter } = buildAdapter('internal_error');
    await (adapter as any)._selfVerify();
    expect(allOutput()).toContain('❌ files.info API');
  });
});
