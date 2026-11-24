// @ts-nocheck — browser-native ESM.
import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { cardAppLinkControl, checkedCardAppLink } from '../../dashboard/console/work-app-link.js';
const ref = 'wc_0123456789abcdef';
const url = `https://instar.sh/a#v=1&i=${'a'.repeat(64)}&t=card&r=${ref}`;

describe('Work card app link', () => {
  it('only accepts the exact identity-based card URL, never a redirect or another card', () => {
    expect(checkedCardAppLink({ url }, ref)).toBe(url);
    for (const bad of ['https://evil.example/', url + '&redirect=https://evil.example', url.replace(ref, 'wc_1111111111111111'), url.replace('https:', 'http:')]) {
      expect(checkedCardAppLink({ url: bad }, ref)).toBeNull();
    }
  });
  it('builds only after an explicit action and leaves the web card in place', async () => {
    const dom = new JSDOM('<body></body>', { url: 'https://agent.example/dashboard#/work/board?card=' + ref });
    const prior = globalThis.document; globalThis.document = dom.window.document;
    try {
      const send = vi.fn().mockResolvedValue({ status: 200, data: { url } });
      const control = cardAppLinkControl(ref, send); document.body.append(control);
      expect(send).not.toHaveBeenCalled();
      control.querySelector('button').click();
      await vi.waitFor(() => expect(control.querySelector('a')?.href).toBe(url));
      expect(send).toHaveBeenCalledWith('/agent-links', { target: 'card', ref });
      expect(dom.window.location.hash).toContain(ref);
      expect(control.textContent).toContain('own pairing');
    } finally { globalThis.document = prior; dom.window.close(); }
  });
  it('refuses failed or unchecked answers with a retry and web fallback', async () => {
    const dom = new JSDOM('<body></body>'); const prior = globalThis.document; globalThis.document = dom.window.document;
    try {
      for (const result of [{ status: 404 }, { status: 200, data: { url: 'https://evil.example' } }]) {
        const control = cardAppLinkControl(ref, async () => result); document.body.append(control);
        control.querySelector('button').click();
        await vi.waitFor(() => expect(control.textContent).toContain('unavailable'));
        expect(control.querySelector('a')).toBeNull();
        expect(control.querySelector('button').disabled).toBe(false);
      }
    } finally { globalThis.document = prior; dom.window.close(); }
  });
});
