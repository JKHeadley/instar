import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Windows companion build', () => {
  it('compiles as a windowless app so no terminal window stays on the user screen', () => {
    const script = readFileSync('scripts/install-windows-desktop-companion.ps1', 'utf8');
    expect(script).toContain('-OutputType WindowsApplication');
    expect(script).not.toContain('-OutputType ConsoleApplication');
  });
});
