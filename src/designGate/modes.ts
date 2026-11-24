export type DesignMode = 'report' | 'block';
/** These structural outcomes are mandated by the approved gate spec, section 3. */
export const DESIGN_STRUCTURAL_ROWS = ['screen-unregistered', 'review-missing', 'render-failed', 'standard-weakened', 'fix-incomplete'] as const;
export interface ModeError { code: string; id?: string }
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The checker catalog must come from trusted executing code, never candidate metadata. */
export function validateDesignModes(value: unknown, checkIds: readonly string[]): ModeError[] {
  if (!object(value) || value.version !== 1 || !object(value.modes)) return [{ code: 'modes-invalid' }];
  const errors: ModeError[] = [];
  if (new Set(checkIds).size !== checkIds.length || checkIds.some(id => typeof id !== 'string' || !id.trim()
    || (DESIGN_STRUCTURAL_ROWS as readonly string[]).includes(id))) errors.push({ code: 'mode-catalog-invalid' });
  const expected = new Set<string>([...DESIGN_STRUCTURAL_ROWS, ...checkIds]);
  for (const id of expected) if (!Object.hasOwn(value.modes, id)) errors.push({ code: 'mode-missing', id });
  for (const [id, mode] of Object.entries(value.modes)) {
    if (!expected.has(id)) errors.push({ code: 'mode-unknown', id });
    if (mode !== 'report' && mode !== 'block') errors.push({ code: 'mode-invalid', id });
    if ((DESIGN_STRUCTURAL_ROWS as readonly string[]).includes(id) && mode !== 'block') errors.push({ code: 'structural-mode-not-blocking', id });
  }
  return errors;
}
