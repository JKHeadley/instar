import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { composeProjects } from '../../src/server/workProjectsRoutes.js';
import { projectsView } from '../../dashboard/console/projects-model.js';
const row = { conversationKey: 'telegram:144201', title: '🎛️ Token Pacing', goal: 'Useful allowance before reset', lastVerdict: 'moving', lastCheckAt: null, parked: false, doneDefinition: [], doneItems: null };
const answer = (priority?: 'high' | 'normal' | 'low') => composeProjects([{ ...row, ...(priority ? { priority } : {}) }], { status: 200, body: { lanes: [] } });
let dom: JSDOM;
afterEach(() => { vi.unstubAllGlobals(); dom?.window.close(); });
async function mount(status = 200) {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/dashboard/console/#/work' });
  for (const name of ['window', 'document', 'location', 'history', 'localStorage', 'HTMLElement', 'Node']) vi.stubGlobal(name, (dom.window as any)[name]);
  const posts: Array<{ path: string; headers: Record<string, string>; body: unknown }> = [];
  vi.stubGlobal('fetch', async (path: string, options: any = {}) => {
    if (options.method === 'POST') {
      posts.push({ path, headers: options.headers, body: JSON.parse(options.body) });
      return { status, json: async () => status === 200 ? { ok: true, priority: 'high' } : { error: 'write-refused' } };
    }
    return { ok: true, status: 200, json: async () => answer('high') };
  });
  const ui = await import('../../dashboard/console/ui.js');
  ui.rememberOperatorSession({ operatorSessionToken: 'owner-proof', operatorSessionExpiresAt: new Date(Date.now() + 600000).toISOString() });
  const { projectsSection } = await import('../../dashboard/console/projects.js');
  dom.window.document.body.append(projectsSection(answer()));
  return { posts, ui };
}
describe('project priority owner controls', () => {
  it('defaults to Normal and carries an explicit priority into the view', () => {
    expect(projectsView(answer()).active[0].priority).toBe('normal');
    expect(projectsView(answer('low')).active[0].priority).toBe('low');
  });
  it('saves the owner-selected value with the existing unlock proof and redraws from the fresh row', async () => {
    const { posts, ui } = await mount();
    try {
      const high = [...document.querySelectorAll('.project-priority button')].find((b) => b.textContent === 'High') as HTMLButtonElement;
      high.click();
      await vi.waitFor(() => expect(document.querySelector('.project-summary')?.textContent).toContain('High priority'));
      expect(posts).toHaveLength(1);
      expect(posts[0].path).toBe('/work/projects/telegram%3A144201/priority');
      expect(posts[0].headers['X-Instar-Operator-Session']).toBe('owner-proof');
      expect(posts[0].body).toEqual({ priority: 'high' });
      expect(document.querySelector('.project-priority button[aria-pressed="true"]')?.textContent).toBe('High');
    } finally { ui.forgetOperatorSession(); }
  });
  it('does not pretend an unconfirmed save succeeded or rolled back', async () => {
    const { ui } = await mount(409);
    try {
      ([...document.querySelectorAll('.project-priority button')].find((b) => b.textContent === 'High') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(document.querySelector('.project-priority [role="status"]')?.textContent).toContain('could not be confirmed'));
      expect(document.querySelector('.project-priority button[aria-pressed="true"]')?.textContent).toBe('Normal');
    } finally { ui.forgetOperatorSession(); }
  });
});
