import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const TEMPLATE_ROOTS = [
  path.join(ROOT, 'src/scaffold/templates'),
  path.join(ROOT, 'src/templates'),
];

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return [full];
  });
}

describe('installed local API templates', () => {
  it('do not ship bearer-only localhost API calls without X-Instar-AgentId', () => {
    const offenders: string[] = [];

    for (const file of TEMPLATE_ROOTS.flatMap(walk)) {
      if (!/\.(md|sh|mjs|ts|json)$/.test(file)) continue;
      const rel = path.relative(ROOT, file);
      const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!line.includes('Authorization: Bearer')) return;
        const commandWindow = lines.slice(index, index + 8).join('\n');
        if (!commandWindow.includes('X-Instar-AgentId')) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
