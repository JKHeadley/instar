import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { coveragePanel } from '../../dashboard/console/measurement-coverage.js';
import { measurementCoverage } from '../../src/monitoring/MeasurementCoverage.js';
describe('measurement coverage view', () => {
  let dom: JSDOM;
  beforeEach(() => { dom = new JSDOM('<!doctype html><body></body>'); Object.assign(globalThis, { document: dom.window.document }); });
  afterEach(() => dom.window.close());
  it('separates missing reads from a zero and gives the warning an action', () => {
    const node = coveragePanel(null);
    expect(node.textContent).toContain('cannot be read'); expect(node.textContent).not.toContain('0 of 0');
    expect(node.querySelector('a')?.href).toContain('sessions?ask=');
  });
  it('shows counted omissions, parent separation and source age without turning coverage into progress', () => {
    const o = measurementCoverage('m1', Date.now(), [{ kind: 'effort', id: 'parent', title: 'Parent effort', sources: ['owner'], subjects: [] },
      { kind: 'effort', id: 'child', title: 'Child work', parentId: 'parent', sources: ['owner'], subjects: [] }], [{ name: 'owner', ok: false }], () => null);
    const node = coveragePanel({ schema: 'measurement-coverage-pool/1', origins: [o], failed: [], poolComplete: false });
    expect(node.textContent).toContain('0 of 2'); expect(node.textContent).toContain('coverage, not improvement');
    expect(node.textContent).toContain('counts are incomplete'); expect(node.textContent).toContain("parent's evidence is separate");
    expect(node.textContent).toContain('Show component: Child work');
    const button = [...node.querySelectorAll('button')].find(b => b.textContent === 'Show component: Child work')!;
    document.body.append(node); button.click();
    expect((document.activeElement as HTMLElement).textContent).toContain('Child work');
    expect(node.textContent).toContain('Oldest read:'); expect(node.querySelector('progress')?.getAttribute('max')).toBe('2');
  });
  it('opens measurements for the exact selected origin and subject with one request', async () => {
    const o=measurementCoverage('m1',Date.now(),[{kind:'feature',id:'flag',title:'Flag',sources:['owner'],subjects:['one']}],[],()=>null);
    const api={get:vi.fn(async()=>({ok:true,data:{schema:'measurement-read/1',state:'missing-contract',detail:null}}))};
    const node=coveragePanel({schema:'measurement-coverage-pool/1',origins:[o],failed:[],poolComplete:false},api);
    const button=[...node.querySelectorAll('button')].find(b=>b.textContent==='Show measurements')!;
    button.click();button.click();await Promise.resolve();await Promise.resolve();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith('/maturation/board?part=measurement&subject=one&machine=m1',12000);
    expect(node.textContent).toContain('No measurement contract is recorded');
  });
  it('renders source names and titles as text, including malicious markup', () => {
    const o = measurementCoverage('m1', Date.now(), [{ kind: 'job', id: 'x', title: '<img src=x onerror=alert(1)>', sources: ['<script>evil</script>'], subjects: [] }], [], () => null);
    const node = coveragePanel({ schema: 'measurement-coverage-pool/1', origins: [o], failed: [], poolComplete: false });
    expect(node.querySelector('img,script')).toBeNull(); expect(node.textContent).toContain('<img');
  });
});
