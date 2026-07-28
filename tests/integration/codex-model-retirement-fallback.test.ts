// safe-git-allow: test fixture writes only inside a private temporary directory.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexCliIntelligenceProvider } from '../../src/core/CodexCliIntelligenceProvider.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/integration/codex-model-retirement-fallback.test.ts:afterEach',
    });
  }
});

describe('Codex model-retirement recovery — structured exec integration', () => {
  it('carries one prompt through retired-model failure to the known-good floor', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-retirement-integration-'));
    dirs.push(dir);
    const binary = path.join(dir, 'codex');
    const calls = path.join(dir, 'calls.txt');
    const prompts = path.join(dir, 'prompts.txt');
    fs.writeFileSync(binary, `#!/bin/sh
OUTFILE=""
MODEL=""
PREV=""
for arg in "$@"; do
  if [ "$PREV" = "--output-last-message" ]; then OUTFILE="$arg"; fi
  if [ "$PREV" = "--model" ]; then MODEL="$arg"; fi
  PREV="$arg"
done
cat >> "${prompts}"
printf '\n' >> "${prompts}"
echo "$MODEL" >> "${calls}"
if [ "$MODEL" = "gpt-5.5" ]; then
  echo "Error 400: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account." >&2
  exit 1
fi
printf 'RECOVERED' > "$OUTFILE"
exit 0
`, { mode: 0o755 });

    const provider = new CodexCliIntelligenceProvider({ codexPath: binary });
    await expect(provider.evaluate('classify this', { model: 'gpt-5.5' })).resolves.toBe('RECOVERED');

    expect(fs.readFileSync(calls, 'utf-8').trim().split('\n')).toEqual([
      'gpt-5.5',
      'gpt-5.4-mini',
    ]);
    expect(fs.readFileSync(prompts, 'utf-8').trim().split('\n')).toEqual([
      'classify this',
      'classify this',
    ]);
  });
});
