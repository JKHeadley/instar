/**
 * gemini-payg-metered-lane §2 "How E1 reaches the server" + "Reviewer family accounting".
 * The gemini-api reviewer family: active only where the door is configured, replaces the
 * gemini CLI there (never a CLI fallback), shares familyKey `gemini`, and is a thin client
 * of the LOCAL server route — it never builds a provider.
 */
import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_REVIEWER_FRAMEWORKS,
  resolveActiveReviewerFrameworks,
  detectGeminiReviewer,
  detectGeminiApiReviewer,
  detectAllCrossModelReviewers,
  isCrossFamilyReviewerFramework,
  isTrustedReviewerFramework,
  runCrossModelReview,
  type CrossModelDetectInputs,
} from '../../src/core/crossModelReviewer.js';

const entry = SUPPORTED_REVIEWER_FRAMEWORKS.find((f) => f.id === 'gemini-api')!;
const door = (over: Partial<NonNullable<CrossModelDetectInputs['geminiApiDoor']>> = {}) => ({ configured: true, ready: true, baseUrl: 'http://127.0.0.1:4040', ...over });
const binding = { specPath: '/x/docs/specs/a.md', specSha256: 'a'.repeat(64), round: 2, runNonce: 'abcdef0123' };

describe('gemini-api reviewer family', () => {
  it('is cross-family, trusted, and shares familyKey gemini with the CLI', () => {
    expect(entry.crossFamily).toBe(true);
    expect(entry.familyKey).toBe('gemini');
    expect(isCrossFamilyReviewerFramework('gemini-api')).toBe(true);
    expect(isTrustedReviewerFramework('gemini-api')).toBe(true);
  });

  it('joins the active set only where the door is configured (fleet set unchanged)', () => {
    expect(resolveActiveReviewerFrameworks(undefined).map((f) => f.id)).not.toContain('gemini-api');
    expect(resolveActiveReviewerFrameworks(undefined, { geminiApiDoor: door({ configured: false }) }).map((f) => f.id)).not.toContain('gemini-api');
    expect(resolveActiveReviewerFrameworks(undefined, { geminiApiDoor: door() }).map((f) => f.id)).toContain('gemini-api');
  });

  it('detects available only when configured, ready, and pointed at loopback', () => {
    expect(detectGeminiApiReviewer({})).toMatchObject({ available: false, reason: 'gemini-api-not-configured' });
    expect(detectGeminiApiReviewer({ geminiApiDoor: door({ ready: false }) })).toMatchObject({ available: false, reason: 'gemini-api-not-ready' });
    expect(detectGeminiApiReviewer({ geminiApiDoor: door({ baseUrl: 'https://evil.example' }) })).toMatchObject({ available: false });
    expect(detectGeminiApiReviewer({ geminiApiDoor: door() })).toMatchObject({ available: true, framework: 'gemini-api', model: 'gemini-4-neon', endpointUrl: 'http://127.0.0.1:4040' });
  });

  it('a configured door EXCLUDES the gemini CLI entirely — an API outage with a CLI signed in reports Gemini unavailable', () => {
    const inputs: CrossModelDetectInputs = { geminiApiDoor: door({ ready: false }), geminiPathDetected: '/usr/bin/gemini' };
    expect(detectGeminiReviewer(inputs)).toMatchObject({ available: false, reason: 'gemini-cli-replaced-by-gemini-api' });
    const all = detectAllCrossModelReviewers({ ...inputs, codexPathDetected: null, grokPathDetected: null, claudePathDetected: null });
    expect(all.some((d) => d.framework === 'gemini-cli' || d.framework === 'gemini-api')).toBe(false);
  });

  it('review posts the bound request to the LOCAL route and folds the verdict', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('authorization') });
      return new Response(JSON.stringify({ status: 'ok', model: 'gemini-4-neon', text: 'VERDICT: ok\nNo design findings.', incomplete: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const saved = process.env.INSTAR_AUTH_TOKEN;
    process.env.INSTAR_AUTH_TOKEN = 'tok-test';
    try {
      const r = await entry.review({ promptText: 'PROMPT', timeoutMs: 1000, detectionOverride: detectGeminiApiReviewer({ geminiApiDoor: door() }), specBinding: binding, geminiApiFetch: fakeFetch });
      expect(r.status).toBe('ok');
      expect(r.framework).toBe('gemini-api');
      expect(seen[0].url).toBe('http://127.0.0.1:4040/intelligence/gemini/review');
      expect(seen[0].body).toMatchObject({ ...binding, promptText: 'PROMPT' });
      expect(seen[0].auth).toBe('Bearer tok-test');
    } finally {
      if (saved === undefined) delete process.env.INSTAR_AUTH_TOKEN; else process.env.INSTAR_AUTH_TOKEN = saved;
    }
  });

  it('records the exact refusal reason as the posture (no step-down here, no CLI fallback); a truncated reply is degraded', async () => {
    process.env.INSTAR_AUTH_TOKEN = process.env.INSTAR_AUTH_TOKEN ?? 'tok-test';
    const mk = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const det = detectGeminiApiReviewer({ geminiApiDoor: door() });
    const r1 = await entry.review({ promptText: 'P', timeoutMs: 1000, detectionOverride: det, specBinding: binding, geminiApiFetch: mk(429, { status: 'unavailable', reason: 'e1-pass-limit' }) });
    expect(r1).toMatchObject({ status: 'unavailable', reason: 'e1-pass-limit', framework: 'gemini-api' });
    const r2 = await entry.review({ promptText: 'P', timeoutMs: 1000, detectionOverride: det, specBinding: binding, geminiApiFetch: mk(200, { status: 'ok', text: 'partial', incomplete: true }) });
    expect(r2).toMatchObject({ status: 'degraded', reason: 'incomplete-response' });
    const r3 = await entry.review({ promptText: 'P', timeoutMs: 1000, detectionOverride: det, geminiApiFetch: mk(200, {}) });
    expect(r3).toMatchObject({ status: 'degraded', reason: 'spec-binding-missing' });
  });

  it('runCrossModelReview --family gemini-api reaches the entry with the binding', async () => {
    let got: Record<string, unknown> | null = null;
    const fakeFetch = (async (_u: string, init: RequestInit) => { got = JSON.parse(String(init.body)); return new Response(JSON.stringify({ status: 'ok', text: 'VERDICT: ok', model: 'gemini-4-neon' }), { status: 200 }); }) as unknown as typeof fetch;
    process.env.INSTAR_AUTH_TOKEN = process.env.INSTAR_AUTH_TOKEN ?? 'tok-test';
    const r = await runCrossModelReview({
      assembled: { promptText: 'ASSEMBLED', truncated: false, omittedLoadBearing: [], undeliverableLoadBearing: [] } as never,
      family: 'gemini-api',
      detectInputs: { geminiApiDoor: door() },
      specBinding: binding,
      geminiApiFetch: fakeFetch,
    });
    expect(r.status).toBe('ok');
    expect(got).toMatchObject({ promptText: 'ASSEMBLED', round: 2 });
  });
});
