import { afterEach, describe, expect, it } from 'vitest';
import { CODEX_CANARY_MODELS, openCodexCanaryProvider } from '../../src/messaging/telegram-origin/OriginCodexModelCanaryProtocol.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of close.splice(0)) await fn(); });
async function provider() { const p = await openCodexCanaryProvider(new AbortController().signal); close.push(p.close); return p; }
describe('Actual loopback canary provider HTTP', () => {
  it('answers both fixed models with scripted Responses events and no tool execution', async () => {
    const p = await provider();
    for (const model of CODEX_CANARY_MODELS) {
      const response = await fetch(`http://127.0.0.1:${p.port}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: true, input: 'fixed test request' }) });
      const text = await response.text(); expect(response.status).toBe(200); expect(text).toContain('event: response.completed');
      expect(text).toContain('CANARY_OK'); expect(text).not.toContain('function_call');
    }
    expect(p.models).toEqual([...CODEX_CANARY_MODELS]); expect(p.failed()).toBe(false);
  });
  it('refuses credentials, arbitrary models, paths and oversized bodies without forwarding', async () => {
    const p = await provider(), url = `http://127.0.0.1:${p.port}/v1/responses`;
    expect((await fetch(url, { method: 'POST', headers: { authorization: 'Bearer fixture-only' }, body: '{}' })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', body: JSON.stringify({ model: 'real-provider-model', stream: true }) })).status).toBe(400);
    expect((await fetch(url + '/other', { method: 'POST' })).status).toBe(403);
    await expect(fetch(url, { method: 'POST', body: 'x'.repeat(256 * 1024 + 1) }).then(r => r.status)).resolves.toBe(400);
    expect(p.models).toEqual([]); expect(p.failed()).toBe(true);
  });
  it('closes its actual listener on cancellation', async () => {
    const abort = new AbortController(), p = await openCodexCanaryProvider(abort.signal); close.push(p.close); abort.abort();
    await p.close(); await expect(fetch(`http://127.0.0.1:${p.port}/v1/responses`)).rejects.toThrow();
  });
});
