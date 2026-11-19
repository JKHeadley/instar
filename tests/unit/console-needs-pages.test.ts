import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { mountNeedsStrip, STRIP_REFRESH_MS } from '../../dashboard/console/needs-strip.js';

const next = 'next+?=/';
const first = 'first/';
const cardHref = (number: number) => `#/work/board?card=wc_${number.toString(16).padStart(16, '0')}`;
function page(start = 0) {
  const count = 105;
  return { ok: true, data: { count, complete: true, couldNotCheck: [], truncated: true,
    items: Array.from({ length: Math.min(100, count - start) }, (_, i) => {
      const number = start + i + 1;
      return { title: `Need ${number}`, why: 'Review this card', tone: 'attn', action: { kind: 'href', href: cardHref(number) } };
    }),
    continuation: { start, nextCursor: start === 0 ? next : null, previousCursor: start === 0 ? null : first },
  } };
}

describe('paging the Needs-you strip', () => {
  let dom: JSDOM, host: HTMLElement, stop: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    dom = new JSDOM('<section></section>', { pretendToBeVisual: true, url: 'https://example.test/' });
    vi.stubGlobal('document', dom.window.document);
    host = document.querySelector('section')!;
  });
  afterEach(() => { stop?.(); dom.window.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  async function mount(get: (path: string) => Promise<unknown>) {
    stop = mountNeedsStrip(host, { get, hrefFor: (a: { href: string }) => a.href });
    await Promise.resolve();
  }
  async function press(label: string) {
    const control = Array.from(host.querySelectorAll('button')).find(b => b.textContent === label);
    expect(control, label).toBeTruthy();
    control!.click();
    await Promise.resolve();
  }
  it('opens action 105, page by page, and reads previous pages without retaining their rows', async () => {
    const get = vi.fn(async path => page(path.endsWith(encodeURIComponent(next)) ? 100 : 0));
    await mount(get);
    expect(host.querySelectorAll('li')).toHaveLength(3);
    await press('Show more needs');
    expect(host.querySelectorAll('li')).toHaveLength(100);
    await press('Next page');
    expect(get).toHaveBeenLastCalledWith('/needs?cursor=' + encodeURIComponent(next));
    expect(host.textContent).toContain('Showing 101–105 of 105');
    expect(host.querySelectorAll('li')).toHaveLength(5);
    host.querySelector<HTMLAnchorElement>(`a[href="${cardHref(105)}"]`)!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(dom.window.location.hash).toBe(cardHref(105));
    await press('Previous page');
    expect(get).toHaveBeenLastCalledWith('/needs?cursor=' + encodeURIComponent(first));
    expect(host.textContent).toContain('Showing 1–100 of 105');
    await press('Show fewer');
    expect(host.querySelectorAll('li')).toHaveLength(3);
  });
  it('offers retry for a dropped page and starts at the current first page after a stale cursor', async () => {
    const get = vi.fn().mockResolvedValueOnce(page()).mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: false, status: 409 }).mockResolvedValueOnce(page());
    await mount(get);
    await press('Show more needs'); await press('Next page');
    expect(host.textContent).toContain('could not be reached');
    await press('Try again');
    expect(get).toHaveBeenLastCalledWith('/needs?cursor=' + encodeURIComponent(next));
    expect(host.textContent).toContain('list changed');
    await press('Reload current list');
    expect(get).toHaveBeenLastCalledWith('/needs');
    expect(host.textContent).toContain('Showing 1–100');
  });
  it('keeps an active action during refresh and clears the list on a denied read', async () => {
    const get = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(page(100))
      .mockResolvedValueOnce(page(100)).mockResolvedValueOnce({ ok: false, status: 403 });
    await mount(get); await press('Show more needs'); await press('Next page');
    const action = host.querySelector<HTMLAnchorElement>('a')!; action.focus();
    await vi.advanceTimersByTimeAsync(STRIP_REFRESH_MS);
    expect(document.activeElement).toBe(action);
    expect(get).toHaveBeenLastCalledWith('/needs?cursor=' + encodeURIComponent(next));
    await vi.advanceTimersByTimeAsync(STRIP_REFRESH_MS);
    expect(host.querySelector('li')).toBeNull();
    expect(host.textContent).not.toContain('Need 101');
  });
  it('refreshes the second page while its heading has focus and reports expiry while an action has focus', async () => {
    const updated = page(100);
    updated.data.items[0].title = 'Updated need';
    const get = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(page(100))
      .mockResolvedValueOnce(updated).mockResolvedValueOnce({ ok: false, status: 409 });
    await mount(get); await press('Show more needs'); await press('Next page');
    expect(document.activeElement).toBe(host.querySelector('.needs-heading'));
    await vi.advanceTimersByTimeAsync(STRIP_REFRESH_MS);
    expect(host.textContent).toContain('Updated need');
    expect(document.activeElement).toBe(host.querySelector('.needs-heading'));
    host.querySelector<HTMLAnchorElement>('a')!.focus();
    await vi.advanceTimersByTimeAsync(STRIP_REFRESH_MS);
    expect(host.textContent).toContain('Reload current list');
    expect(host.querySelector('a')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('.needs-heading'));
  });
  it('ignores stale navigation after remount and rejects skipped ranges', async () => {
    let resolve!: (value: ReturnType<typeof page>) => void;
    const get = vi.fn().mockResolvedValueOnce(page()).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    await mount(get); await press('Show more needs'); await press('Next page');
    await mount(vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(page(99)));
    resolve(page(100)); await Promise.resolve();
    expect(host.querySelectorAll('li')).toHaveLength(3);
    await press('Show more needs'); await press('Next page');
    expect(host.textContent).toContain('page could not be read');
    expect(host.querySelector('li')).toBeNull();
  });
});
