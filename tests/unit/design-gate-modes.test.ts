import { describe, it, expect } from 'vitest';
import { DESIGN_STRUCTURAL_ROWS, validateDesignModes } from '../../src/designGate/modes.js';
const policy = () => ({ version: 1, modes: Object.fromEntries([
  ...DESIGN_STRUCTURAL_ROWS.map(id => [id, 'block']), ['contrast', 'report'],
]) });
describe('explicit design check modes', () => {
  it('allows a checker to mature from report to block without changing structural rows', () => {
    const p = policy();
    expect(validateDesignModes(p, ['contrast'])).toEqual([]);
    p.modes.contrast = 'block';
    expect(validateDesignModes(p, ['contrast'])).toEqual([]);
  });
  it('does not let the candidate turn off a structural outcome', () => {
    const p = policy(); p.modes['standard-weakened'] = 'report';
    expect(validateDesignModes(p, ['contrast'])).toContainEqual({ code: 'structural-mode-not-blocking', id: 'standard-weakened' });
  });
  it('requires exactly the trusted checker and structural domain', () => {
    const p = policy(); delete p.modes.contrast; p.modes.invented = 'block';
    expect(validateDesignModes(p, ['contrast'])).toEqual([
      { code: 'mode-missing', id: 'contrast' }, { code: 'mode-unknown', id: 'invented' },
    ]);
  });
  it('refuses unreadable modes, unknown enum values and colliding checker catalogs', () => {
    expect(validateDesignModes(null, ['contrast'])).toEqual([{ code: 'modes-invalid' }]);
    const p = policy(); p.modes.contrast = 'disabled';
    expect(validateDesignModes(p, ['contrast'])).toContainEqual({ code: 'mode-invalid', id: 'contrast' });
    expect(validateDesignModes(policy(), ['contrast', 'contrast'])).toContainEqual({ code: 'mode-catalog-invalid' });
    expect(validateDesignModes(policy(), ['screen-unregistered', 'contrast'])).toContainEqual({ code: 'mode-catalog-invalid' });
  });
});
