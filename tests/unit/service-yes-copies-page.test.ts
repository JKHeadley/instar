/**
 * SEC-129, the page side: the bitwarden confirm page shows the COUNT of secrets the copy takes, and
 * shows their names only after the person types the PIN and taps "Show their names" (a POST with
 * answer 'names'). Loads the real dashboard-pair/service-yes.js into jsdom with a stubbed fetch.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const SCRIPT = fs.readFileSync(path.join(__dirname, '../../dashboard-pair/service-yes.js'), 'utf-8');
const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

function boot(namesAnswer: (body: Record<string, unknown>) => ReturnType<typeof json>) {
  const dom = new JSDOM('<!doctype html><body><div id="pair-root"></div></body>', { url: 'https://echo.example.dev/dashboard/service-yes?service=bitwarden', runScripts: 'outside-only' });
  const posts: Array<Record<string, unknown>> = [];
  (dom.window as unknown as { fetch: unknown }).fetch = async (_url: string, o: { method?: string; body?: string } = {}) => {
    if ((o.method ?? 'GET') === 'GET') return json(200, { service: 'bitwarden', name: 'Bitwarden', benefit: 'b', dataLeaves: 'd', cost: 'c', account: 'a', canSetUp: true, copiesCount: 3, token: 'tok-1' });
    const body = JSON.parse(o.body ?? '{}');
    posts.push(body);
    return namesAnswer(body);
  };
  dom.window.eval(SCRIPT);
  return { doc: dom.window.document, posts, win: dom.window };
}
const button = (doc: Document, text: string) => [...doc.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined;

describe('SEC-129: the confirm page shows secret names only after the PIN', () => {
  it('first shows the count and no names', async () => {
    const { doc } = boot(() => json(200, { copies: ['authToken', 'dashboardPin', 'tunnel.token'] }));
    await flush();
    const text = doc.body.textContent ?? '';
    expect(text).toContain('A copy of 3 stored secrets');
    expect(text).not.toContain('authToken');
    expect(button(doc, 'Show their names')).toBeDefined();
  });

  it('with the PIN, "Show their names" asks with answer names and the live token, then lists them', async () => {
    const { doc, posts } = boot(() => json(200, { copies: ['authToken', 'dashboardPin', 'tunnel.token'] }));
    await flush();
    (doc.querySelector('input[type=password]') as HTMLInputElement).value = '1234';
    button(doc, 'Show their names')!.click();
    await flush();
    expect(posts).toEqual([{ token: 'tok-1', pin: '1234', answer: 'names', reason: 'none', shutdown: false }]);
    expect(doc.body.textContent).toContain('by name: authToken, dashboardPin, tunnel.token');
    expect(button(doc, 'Show their names')).toBeUndefined();
  });

  it('a wrong PIN says so and shows no names', async () => {
    const { doc } = boot(() => json(403, { error: 'pin-refused' }));
    await flush();
    (doc.querySelector('input[type=password]') as HTMLInputElement).value = '0000';
    button(doc, 'Show their names')!.click();
    await flush();
    expect(doc.body.textContent).toContain('That PIN didn’t work');
    expect(doc.body.textContent).not.toContain('by name:');
    expect((doc.querySelector('input[type=password]') as HTMLInputElement).value).toBe('');
  });
});
