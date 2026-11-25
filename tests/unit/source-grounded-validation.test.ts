import { describe, expect, it } from 'vitest';
// @ts-expect-error Internal evaluation script has no public TypeScript interface.
import { strictParse, validateCapture } from '../../scripts/evaluation/source_grounded_validate.mjs';

import { capture } from '../fixtures/source-grounded-capture.js';

describe('strict captured data parsing', () => {
  it('rejects escaped duplicate keys at nested levels', () => {
    expect(() => strictParse('{"a":{"x":1,"\\u0078":2}}', 1024)).toThrow('duplicate-key');
    expect(strictParse('{"a":{"x":1},"b":{"x":2}}', 1024)).toEqual({ a: { x: 1 }, b: { x: 2 } });
  });
  it('rejects nonfinite, oversized and excessively deep JSON', () => {
    expect(() => strictParse('{"x":1e400}', 1024)).toThrow('nonfinite-number');
    expect(() => strictParse('\"\\ud800\"', 1024)).toThrow('invalid-unicode-string');
    expect(() => strictParse('"😀"', 4)).toThrow('payload-too-large');
    expect(() => strictParse('['.repeat(110) + '0' + ']'.repeat(110), 1024)).toThrow('nesting-too-deep');
  });
});

describe('answer boundaries', () => {
  it('accepts Unicode code point spans without semantic approval', () => {
    expect(validateCapture(capture())).toMatchObject({ answer: { state: 'structurally-valid' }, judge: { state: 'structurally-valid' }, qualificationAuthorized: false });
  });
  it.each([[2, 2], [1, 4], [-1, 2]])('rejects invalid citation span %j', (start, end) => {
    const c = capture(); const a = JSON.parse(c.answerRaw); a.claims[0].citations[0] = { sourceId: 's', start, end }; c.answerRaw = JSON.stringify(a);
    expect(validateCapture(c).answer.state).toBe('failed-answer');
  });
  it('rejects unknown and withheld answer citations', () => {
    const c = capture(); c.availableSourceIds = [];
    expect(validateCapture(c).answer.state).toBe('failed-answer');
  });
  it('rejects duplicate claims and supported answer without claims', () => {
    const c = capture(); const a = JSON.parse(c.answerRaw); a.claims.push(a.claims[0]); c.answerRaw = JSON.stringify(a);
    expect(validateCapture(c).answer.state).toBe('failed-answer');
    a.claims = []; c.answerRaw = JSON.stringify(a); expect(validateCapture(c).answer.state).toBe('failed-answer');
  });
});

it('rejects distinct lone surrogates rather than hashing their replacement encodings', () => {
  for (const value of ['\ud800', '\ud801']) {
    expect(() => strictParse(JSON.stringify(value), 1024)).toThrow('invalid-unicode-string');
    const c = capture(); c.sources[0].text = value;
    expect(() => validateCapture(c)).toThrow('invalid-unicode-string');
  }
  expect(strictParse(JSON.stringify('�'), 1024)).toBe('�');
});
