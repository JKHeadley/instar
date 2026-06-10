#!/usr/bin/env node
/**
 * throwaway-identity.mjs — CLI for the disposable-identity helper (lib/throwaway-identity.mjs).
 *
 *   node scripts/throwaway-identity.mjs mint
 *       → mints a fresh inbox; prints JSON { address, password, token, accountId }.
 *
 *   node scripts/throwaway-identity.mjs wait <token> [--subject S] [--from F]
 *                                       [--code | --link [MATCH]] [--timeout MS]
 *       → polls the inbox until a matching message arrives, then prints either
 *         the full message JSON, or (with --code/--link) just the extracted value.
 *
 * Use for live-integration test-identity provisioning (the autonomous half — an
 * anti-bot signup CAPTCHA at account creation is the human handoff).
 */
import {
  createInbox,
  waitForMessage,
  extractCode,
  extractLink,
} from './lib/throwaway-identity.mjs';

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--code') out.code = true;
    else if (a === '--link') { out.link = true; if (args[i + 1] && !args[i + 1].startsWith('--')) out.linkMatch = args[++i]; }
    else if (a === '--subject') out.subject = args[++i];
    else if (a === '--from') out.from = args[++i];
    else if (a === '--timeout') out.timeout = parseInt(args[++i], 10);
    else out._.push(a);
  }
  return out;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  if (cmd === 'mint') {
    const inbox = await createInbox();
    process.stdout.write(JSON.stringify(inbox) + '\n');
    return;
  }

  if (cmd === 'wait') {
    const token = flags._[0];
    if (!token) { console.error('usage: throwaway-identity.mjs wait <token> [--subject S] [--from F] [--code|--link [MATCH]] [--timeout MS]'); process.exit(1); }
    const msg = await waitForMessage(token, {
      subject: flags.subject,
      from: flags.from,
      timeoutMs: flags.timeout ?? 120_000,
    });
    const text = msg.text || msg.html?.join?.('\n') || (Array.isArray(msg.html) ? msg.html.join('\n') : msg.html) || '';
    if (flags.code) {
      const code = extractCode(text);
      if (!code) { console.error('no verification code found in message'); process.exit(1); }
      process.stdout.write(code + '\n');
    } else if (flags.link) {
      const link = extractLink(text, flags.linkMatch ? { match: flags.linkMatch } : {});
      if (!link) { console.error('no link found in message'); process.exit(1); }
      process.stdout.write(link + '\n');
    } else {
      process.stdout.write(JSON.stringify({ subject: msg.subject, from: msg.from, text }) + '\n');
    }
    return;
  }

  console.error('usage: throwaway-identity.mjs <mint | wait>');
  process.exit(1);
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}
