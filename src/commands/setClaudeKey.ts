/**
 * `instar set-claude-key` — put a new Claude sign-in key in place (spec cloud-key-internal-calls).
 * Reads the key from stdin or a hidden prompt, never argv. A running server finds it within a minute.
 */

import path from 'node:path';
import readline from 'node:readline';
import pc from 'picocolors';
import { loadConfig } from '../core/Config.js';
import { looksLikeClaudeToken, writeClaudeKeyToConfig } from '../core/claudeChildAuth.js';

async function readPiped(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf-8');
}

function readHidden(): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write('Paste the key from claude setup-token (it will not show): ');
    const rl = readline.createInterface({ input: process.stdin, terminal: true });
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    rl.once('line', (line) => { rl.close(); process.stdout.write('\n'); resolve(line); });
  });
}

export async function setClaudeKey(opts: { dir?: string }): Promise<void> {
  const config = loadConfig(opts.dir);
  const value = (process.stdin.isTTY ? await readHidden() : await readPiped()).trim();
  if (!looksLikeClaudeToken(value)) {
    console.error(pc.red("That doesn't look like a key from claude setup-token. It starts with sk-ant-oat. Nothing was changed."));
    process.exitCode = 1;
    return;
  }
  writeClaudeKeyToConfig(path.join(config.stateDir, 'config.json'), value);
  console.log(pc.green('Key saved. Your agent picks it up by itself, and open conversations recover without anything more from you.'));
}
