#!/usr/bin/env node
/**
 * telegram-history-backfill — CLI entry for one-shot user-account MTProto
 * backfill of a Telegram forum supergroup into instar topic-memory.db.
 *
 * Context. On 2026-05-20 Echo's local topic-memory.db was truncated during
 * the Node 22→25 better-sqlite3 native-module cascade recovery. The Bot API
 * has no history-fetch primitive (forward-only by design). A user-account
 * MTProto session is the only path back. This is that path.
 *
 * Two-step usage (interactive auth required the first time):
 *
 *   # 1. One-time auth — captures the session string for re-use
 *   node scripts/telegram-history-backfill.mjs --auth
 *
 *   # 2. Backfill the lifeline supergroup (all topics, idempotent)
 *   node scripts/telegram-history-backfill.mjs --chat -1003742343280
 *
 *   # Single-topic backfill (e.g. topic 10873):
 *   node scripts/telegram-history-backfill.mjs --chat -1003742343280 --topic 10873
 *
 *   # Dry run (no writes; counts only):
 *   node scripts/telegram-history-backfill.mjs --chat -1003742343280 --dry-run
 *
 * Credential resolution (in order of preference):
 *   1. --secrets-path <file> (JSON: { api_id, api_hash, sessionFilePath })
 *   2. INSTAR_TELEGRAM_API_ID + INSTAR_TELEGRAM_API_HASH env vars
 *   3. Default: ~/.local/share/instar-echo-secrets/telegram-mtproto.json
 *
 * The session string lives at sessionFilePath (mode 0600). Treat it like a
 * password. It expires only when the operator revokes it via Telegram
 * Settings → Devices.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { TelegramHistorian } from './lib/telegram-historian.mjs';
import { TopicMemoryImporter } from './lib/topic-memory-importer.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--auth') args.auth = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--chat') args.chat = argv[++i];
    else if (a === '--topic') args.topic = Number(argv[++i]);
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--secrets-path') args.secretsPath = argv[++i];
    else if (a === '--min-message-id') args.minMessageId = Number(argv[++i]);
    else if (a === '--phone') args.phone = argv[++i];
    else if (a === '--code-file') args.codeFile = argv[++i];
    else if (a === '--password-file') args.passwordFile = argv[++i];
    else if (a === '--code-poll-seconds') args.codePollSeconds = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

function pollForFileContent(filePath, opts = {}) {
  const intervalMs = (opts.intervalSeconds ?? 2) * 1000;
  const timeoutMs = (opts.timeoutSeconds ?? 600) * 1000;
  const onWait = opts.onWait ?? (() => {});
  return new Promise((resolve, reject) => {
    const started = Date.now();
    onWait(filePath);
    const t = setInterval(() => {
      try {
        if (fs.existsSync(filePath)) {
          const v = fs.readFileSync(filePath, 'utf8').trim();
          if (v.length > 0) {
            clearInterval(t);
            // wipe the file after read so the next prompt requires a fresh write
            try { fs.writeFileSync(filePath, ''); } catch {}
            resolve(v);
            return;
          }
        }
      } catch {
        // keep polling
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(t);
        reject(new Error(`Timed out waiting for ${filePath} after ${timeoutMs / 1000}s`));
      }
    }, intervalMs);
  });
}

function helpText() {
  return [
    'telegram-history-backfill — one-shot MTProto backfill into topic-memory.db',
    '',
    'USAGE',
    '  node scripts/telegram-history-backfill.mjs [--auth] [--chat <id>] [--topic <id>]',
    '                                              [--dry-run] [--verbose]',
    '                                              [--db <path>] [--secrets-path <path>]',
    '',
    'FLAGS',
    '  --auth             One-time interactive auth (captures the session string)',
    '  --chat <id>        Supergroup id (e.g. -1003742343280) or @username',
    '  --topic <id>       Optional. Single forum topic id (skips listing topics)',
    '  --dry-run          Read-only; reports counts but does not write to db',
    '  --verbose          Per-page progress logs to stderr',
    '  --db <path>        Override topic-memory.db path (default: <agent>/.instar/topic-memory.db)',
    '  --secrets-path <p> Override credentials file path',
    '  --min-message-id N Skip messages with id ≤ N (resumes from a known watermark)',
    '',
    'EXIT CODES',
    '  0   success',
    '  1   recoverable error (network, auth)',
    '  2   bad input (missing creds, invalid flag)',
  ].join('\n');
}

function resolveSecretsPath(arg) {
  if (arg) return arg;
  return path.join(os.homedir(), '.local', 'share', 'instar-echo-secrets', 'telegram-mtproto.json');
}

function loadCredentials(secretsPath) {
  const fromEnv = (process.env.INSTAR_TELEGRAM_API_ID && process.env.INSTAR_TELEGRAM_API_HASH)
    ? {
        apiId: Number(process.env.INSTAR_TELEGRAM_API_ID),
        apiHash: process.env.INSTAR_TELEGRAM_API_HASH,
        sessionFilePath:
          process.env.INSTAR_TELEGRAM_SESSION_PATH
          ?? path.join(os.homedir(), '.local', 'share', 'instar-echo-secrets', 'telegram-mtproto.session'),
      }
    : null;
  if (fromEnv) return fromEnv;

  if (!fs.existsSync(secretsPath)) {
    throw new Error(
      `No credentials found. Expected one of:\n` +
        `  - file at ${secretsPath}\n` +
        `  - env vars INSTAR_TELEGRAM_API_ID + INSTAR_TELEGRAM_API_HASH`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  if (!raw.api_id || !raw.api_hash) {
    throw new Error(`Credentials file ${secretsPath} missing api_id or api_hash`);
  }
  return {
    apiId: Number(raw.api_id),
    apiHash: String(raw.api_hash),
    sessionFilePath: raw.sessionFilePath
      ? raw.sessionFilePath.replace(/^~/, os.homedir())
      : path.join(path.dirname(secretsPath), 'telegram-mtproto.session'),
  };
}

function resolveDbPath(arg) {
  if (arg) return arg;
  // Default: this worktree's parent agent home if we can find one. Fall back
  // to the canonical path Echo uses.
  const candidates = [
    process.env.INSTAR_AGENT_HOME && path.join(process.env.INSTAR_AGENT_HOME, '.instar', 'topic-memory.db'),
    path.join(os.homedir(), '.instar', 'agents', 'echo', '.instar', 'topic-memory.db'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`No topic-memory.db found. Tried: ${candidates.join(', ')}`);
}

function makeRl() {
  return readline.createInterface({ input: process.stdin, output: process.stderr });
}

function ask(rl, prompt, opts = {}) {
  return new Promise((resolve) => {
    const wasMuted = opts.silent === true;
    if (wasMuted) {
      // crude muted prompt — does not echo
      rl.question(prompt, (answer) => resolve(answer));
      // intentionally not toggling stdout — gramjs internals handle this for
      // the password case, and the SMS code is not strictly secret post-use.
    } else {
      rl.question(prompt, (answer) => resolve(answer));
    }
  });
}

async function runAuth(creds, opts) {
  const historian = new TelegramHistorian(creds, { verbose: opts.verbose });

  // Auth supports three driving modes:
  //   1. Fully interactive (stdin readline) — original behaviour, used when
  //      a human sits at the terminal.
  //   2. Non-interactive with phone via --phone and code via --code-file
  //      (the autonomous-agent path: the orchestrator writes the SMS code
  //      to the file when the operator sends it, and the script picks it
  //      up via a file-poll).
  //   3. Mix: --phone provided non-interactively, code prompted via stdin.
  const useStdinForPhone = !opts.phone;
  const useStdinForCode = !opts.codeFile;
  const usePasswordFile = Boolean(opts.passwordFile);
  const rl = useStdinForPhone || useStdinForCode ? makeRl() : null;

  try {
    await historian.connect({
      onPhoneNumber: async () => {
        if (opts.phone) {
          process.stderr.write(`[auth] using phone from --phone flag\n`);
          return opts.phone.trim();
        }
        const v = await ask(rl, '[auth] Phone number (with country code, e.g. +1...): ');
        return v.trim();
      },
      onCode: async () => {
        if (opts.codeFile) {
          process.stderr.write(
            `[auth] AWAITING_SMS_CODE — write the code to ${opts.codeFile} (one line, digits only)\n`,
          );
          return await pollForFileContent(opts.codeFile, {
            intervalSeconds: 2,
            timeoutSeconds: opts.codePollSeconds ?? 600,
            onWait: (p) => process.stderr.write(`[auth] polling ${p} every 2s (timeout 10m)\n`),
          });
        }
        const v = await ask(rl, '[auth] SMS code: ');
        return v.trim();
      },
      onPassword: async () => {
        if (usePasswordFile) {
          process.stderr.write(`[auth] reading 2FA password from ${opts.passwordFile}\n`);
          const v = fs.readFileSync(opts.passwordFile, 'utf8').trim();
          if (!v) throw new Error(`Password file ${opts.passwordFile} is empty`);
          return v;
        }
        if (!rl) {
          throw new Error('2FA password required but no readline + no --password-file');
        }
        const v = await ask(rl, '[auth] 2FA password (if enabled): ', { silent: true });
        return v.trim();
      },
      onError: (err) => {
        process.stderr.write(`[auth] error: ${err.message}\n`);
      },
    });
    process.stderr.write('[auth] success — session string saved.\n');
  } finally {
    if (rl) rl.close();
    await historian.disconnect();
  }
}

async function runBackfill(creds, opts) {
  if (!opts.chat) throw new Error('--chat is required (e.g. --chat -1003742343280)');
  const dbPath = resolveDbPath(opts.db);
  const historian = new TelegramHistorian(creds, { verbose: opts.verbose });

  await historian.connect({
    onPhoneNumber: async () => {
      throw new Error('No saved session — run --auth first');
    },
    onCode: async () => {
      throw new Error('No saved session — run --auth first');
    },
  });

  const importer = opts.dryRun ? null : new TopicMemoryImporter(dbPath);
  const totals = { inserted: 0, skipped: 0, fetched: 0, topicsTouched: 0 };

  try {
    let topics;
    if (opts.topic) {
      topics = [{ id: opts.topic, title: `(single topic ${opts.topic})`, topMessageId: opts.topic, closed: false }];
    } else {
      process.stderr.write('[backfill] listing forum topics...\n');
      topics = await historian.listForumTopics(opts.chat);
      process.stderr.write(`[backfill] found ${topics.length} topics\n`);
    }

    for (const t of topics) {
      process.stderr.write(`[backfill] topic ${t.id} (${t.title})...\n`);
      let batch = [];
      let topicFetched = 0;
      for await (const msg of historian.iterTopicMessages(opts.chat, t.id, {
        minMessageId: opts.minMessageId ?? 0,
        batchSize: 100,
      })) {
        batch.push(msg);
        topicFetched++;
        totals.fetched++;
        if (batch.length >= 200) {
          if (importer) {
            const r = importer.importBatch(batch);
            totals.inserted += r.inserted;
            totals.skipped += r.skipped;
          }
          batch = [];
        }
      }
      if (batch.length && importer) {
        const r = importer.importBatch(batch);
        totals.inserted += r.inserted;
        totals.skipped += r.skipped;
      }
      totals.topicsTouched++;
      process.stderr.write(
        `[backfill] topic ${t.id} done: fetched=${topicFetched}` +
          (importer ? ` inserted=${totals.inserted} skipped=${totals.skipped}` : ' (dry-run)') +
          '\n',
      );
    }
  } finally {
    if (importer) importer.close();
    await historian.disconnect();
  }

  process.stderr.write(
    `[backfill] summary: topics=${totals.topicsTouched} fetched=${totals.fetched} ` +
      `inserted=${totals.inserted} skipped=${totals.skipped} (dry-run=${Boolean(opts.dryRun)})\n`,
  );
  process.stdout.write(JSON.stringify(totals) + '\n');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(helpText() + '\n');
    return 0;
  }
  const secretsPath = resolveSecretsPath(args.secretsPath);
  let creds;
  try {
    creds = loadCredentials(secretsPath);
  } catch (err) {
    process.stderr.write(`[creds] ${err.message}\n`);
    return 2;
  }
  if (args.auth) {
    await runAuth(creds, args);
    return 0;
  }
  if (args.chat) {
    await runBackfill(creds, args);
    return 0;
  }
  process.stderr.write(helpText() + '\n');
  return 2;
}

main().then((code) => process.exit(code ?? 0)).catch((err) => {
  process.stderr.write(`[fatal] ${err.stack ?? err.message}\n`);
  process.exit(1);
});
