/**
 * Tests for PostUpdateMigrator.migrateReplyScriptToPortConfig (Layer 1
 * migration). Spec: docs/specs/telegram-delivery-robustness.md § Layer 1.
 *
 * The migrator detects prior shipped versions by SHA-256, not marker
 * strings. Three branches:
 *   - existing SHA ∈ TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS → backup + overwrite.
 *   - existing SHA == new template SHA → no-op (idempotent).
 *   - otherwise → write `<scriptPath>.new`, raise `relay-script-modified-locally`
 *     degradation event, leave original untouched.
 *
 * Plus: double-run idempotency (running the migrator twice never
 * produces a second backup or a second .new file).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { PostUpdateMigrator, type MigrationResult } from '../../src/core/PostUpdateMigrator.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const PROJECT_TEMPLATE = path.join(process.cwd(), 'src/templates/scripts/telegram-reply.sh');
const PRIOR_SHIPPED_SHA = '3d08c63c6280d0a7ba94a345c259673a461ee5c1d116cb47c95c7626c67cee23';

// Reconstruct the prior shipped content (the version that lives in git
// before this PR's changes) by reading it from the git index. Falls back
// to a hardcoded copy if git isn't available — the SHA must match either
// way for the migrator to recognize it.
function priorShippedContent(): string {
  // Hardcoded copy of the prior version to keep this test self-contained.
  // The content here must hash to PRIOR_SHIPPED_SHA — if a future change
  // to the prior template is required, both must update together.
  const text = `#!/bin/bash
# telegram-reply.sh — Send a message back to a Telegram topic via instar server.
#
# Usage:
#   ./telegram-reply.sh TOPIC_ID "message text"
#   ./telegram-reply.sh --format markdown TOPIC_ID "**bold**"
#   echo "message text" | ./telegram-reply.sh TOPIC_ID
#   cat <<'EOF' | ./telegram-reply.sh TOPIC_ID
#   Multi-line message here
#   EOF
#
# Flags:
#   --format <mode>   Override server-side format mode for this send.
#                     Valid: plain, code, markdown, legacy-passthrough
#                     ('html' is reserved for trusted internal callers.)
#                     When absent, the server's configured default applies.
#
# Reads INSTAR_PORT from environment (default: 4040).

FORMAT=""

# Parse leading flags before positional args.
while [ $# -gt 0 ]; do
  case "$1" in
    --format)
      FORMAT="$2"
      shift 2
      ;;
    --format=*)
      FORMAT="\${1#--format=}"
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

TOPIC_ID="$1"
shift

if [ -z "$TOPIC_ID" ]; then
  echo "Usage: telegram-reply.sh [--format MODE] TOPIC_ID [message]" >&2
  exit 1
fi

# Read message from args or stdin
if [ $# -gt 0 ]; then
  MSG="$*"
else
  MSG="$(cat)"
fi

if [ -z "$MSG" ]; then
  echo "No message provided" >&2
  exit 1
fi

PORT="\${INSTAR_PORT:-4040}"

# Read auth token from config (if present)
AUTH_TOKEN=""
if [ -f ".instar/config.json" ]; then
  AUTH_TOKEN=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)
fi

# Build JSON body (text + optional format).
JSON_BODY=$(python3 -c '
import sys, json
msg = sys.argv[1]
fmt = sys.argv[2]
body = {"text": msg}
if fmt:
    body["format"] = fmt
print(json.dumps(body))
' "$MSG" "$FORMAT" 2>/dev/null)

if [ -z "$JSON_BODY" ]; then
  # Fallback if python3 not available: basic escape, no format override.
  ESCAPED=$(printf '%s' "$MSG" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g; s/\\n/\\\\n/g')
  JSON_BODY="{\\"text\\":\\"\${ESCAPED}\\"}"
fi

if [ -n "$AUTH_TOKEN" ]; then
  RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://localhost:\${PORT}/telegram/reply/\${TOPIC_ID}" \\
    -H 'Content-Type: application/json' \\
    -H "Authorization: Bearer \${AUTH_TOKEN}" \\
    -d "$JSON_BODY")
else
  RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://localhost:\${PORT}/telegram/reply/\${TOPIC_ID}" \\
    -H 'Content-Type: application/json' \\
    -d "$JSON_BODY")
fi

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  echo "Sent $(echo "$MSG" | wc -c | tr -d ' ') chars to topic $TOPIC_ID"
elif [ "$HTTP_CODE" = "408" ]; then
  # Request timeout on the server side — the outbound path (tone gate + Telegram API)
  # exceeded the route's budget. The actual send may have completed anyway, because
  # the handler's async work continues after the middleware fires 408. Treating this
  # as a hard failure (exit 1) causes the agent to regenerate and retry, which
  # double-sends the message. Instead report the outcome as AMBIGUOUS and exit 0 —
  # the agent should check the conversation before retrying.
  echo "AMBIGUOUS (HTTP 408): server timed out; the message MAY have been delivered." >&2
  echo "  Do NOT retry blindly — check the conversation to verify delivery before resending." >&2
  echo "  If the message is there, proceed; if not, retry with a shorter/simpler version." >&2
  echo "AMBIGUOUS (HTTP 408): outcome unknown — verify in conversation before retrying"
  exit 0
elif [ "$HTTP_CODE" = "422" ]; then
  # Tone gate blocked the message — surface the issue + suggestion to the agent
  ISSUE=$(echo "$BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("issue","unknown"))' 2>/dev/null || echo "unknown")
  SUGGESTION=$(echo "$BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("suggestion",""))' 2>/dev/null || echo "")
  echo "BLOCKED by tone gate — message not sent to user." >&2
  echo "  Issue: $ISSUE" >&2
  if [ -n "$SUGGESTION" ]; then
    echo "  Suggestion: $SUGGESTION" >&2
  fi
  echo "  Revise the message (remove CLI commands, file paths, config syntax, API endpoints) and retry." >&2
  exit 1
else
  echo "Failed (HTTP $HTTP_CODE): $BODY" >&2
  exit 1
fi
`;
  return text;
}

function newTemplateContent(): string {
  return fs.readFileSync(PROJECT_TEMPLATE, 'utf-8');
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

interface Harness {
  projectDir: string;
  stateDir: string;
  scriptPath: string;
  run: (existing: string) => MigrationResult;
}

function buildHarness(): Harness {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-migrate-'));
  const stateDir = path.join(projectDir, '.instar');
  const scriptsDir = path.join(projectDir, '.claude', 'scripts');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  const scriptPath = path.join(scriptsDir, 'telegram-reply.sh');

  const migrator = new PostUpdateMigrator({
    projectDir,
    stateDir,
    port: 4042,
    hasTelegram: true,
    projectName: 'test-agent',
  });

  // Reach the private method via the same cast pattern used in the
  // existing migrator tests. We exercise the SHA-based migrator
  // directly so we don't pull in unrelated migrate-script side effects.
  const callMigrate = (
    migrator as unknown as {
      migrateReplyScriptToPortConfig: (opts: {
        scriptPath: string;
        newContent: string;
        label: string;
        stateDir: string;
        result: MigrationResult;
      }) => void;
    }
  ).migrateReplyScriptToPortConfig.bind(migrator);

  return {
    projectDir,
    stateDir,
    scriptPath,
    run(existing: string): MigrationResult {
      fs.writeFileSync(scriptPath, existing, { mode: 0o755 });
      const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
      callMigrate({
        scriptPath,
        newContent: newTemplateContent(),
        label: 'scripts/telegram-reply.sh',
        stateDir,
        result,
      });
      return result;
    },
  };
}

describe('PostUpdateMigrator.migrateReplyScriptToPortConfig', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
    // Clear degradation state between tests so we can assert on per-test events.
    DegradationReporter.resetForTesting();
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(harness.projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/migration-relay-script-hash.test.ts',
    });
  });

  it('precondition: hardcoded prior content hashes to the registered prior SHA', () => {
    expect(sha256(priorShippedContent())).toBe(PRIOR_SHIPPED_SHA);
  });

  it('overwrites in place AND backs up when on-disk SHA matches a known prior shipped SHA', () => {
    const prior = priorShippedContent();
    const result = harness.run(prior);

    // New content was written.
    const after = fs.readFileSync(harness.scriptPath, 'utf-8');
    expect(after).toBe(newTemplateContent());
    expect(result.upgraded.some((u) => u.includes('telegram-reply.sh'))).toBe(true);

    // Backup exists with the prior bytes verbatim.
    const backupDir = path.join(harness.stateDir, 'backups');
    expect(fs.existsSync(backupDir)).toBe(true);
    const backups = fs.readdirSync(backupDir);
    const match = backups.find((f) => f.startsWith('telegram-reply.sh.'));
    expect(match).toBeDefined();
    const backedUp = fs.readFileSync(path.join(backupDir, match!), 'utf-8');
    expect(backedUp).toBe(prior);
  });

  it('is a no-op when on-disk SHA matches the new template SHA', () => {
    const newContent = newTemplateContent();
    const result = harness.run(newContent);

    // No mutation, no errors, no upgrade record.
    expect(fs.readFileSync(harness.scriptPath, 'utf-8')).toBe(newContent);
    expect(result.upgraded).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.skipped.some((s) => s.includes('already current'))).toBe(true);

    // No backup directory should have been created (idempotent).
    const backupDir = path.join(harness.stateDir, 'backups');
    if (fs.existsSync(backupDir)) {
      expect(fs.readdirSync(backupDir)).toHaveLength(0);
    }
  });

  it('writes a .new candidate and raises a degradation event on user-modified content', () => {
    const customized = '#!/bin/bash\n# my custom relay script\necho "custom"\n';
    const result = harness.run(customized);

    // Original is preserved.
    expect(fs.readFileSync(harness.scriptPath, 'utf-8')).toBe(customized);

    // .new candidate is alongside.
    const candidatePath = `${harness.scriptPath}.new`;
    expect(fs.existsSync(candidatePath)).toBe(true);
    expect(fs.readFileSync(candidatePath, 'utf-8')).toBe(newTemplateContent());

    // Degradation event raised.
    const events = DegradationReporter.getInstance().getEvents();
    const event = events.find((e) => e.feature === 'relay-script-modified-locally');
    expect(event).toBeDefined();

    // Result reports a skip (the original was untouched), not an upgrade.
    expect(result.upgraded).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('is idempotent: running twice on a prior-shipped script does not create a second backup nor double-overwrite', () => {
    const prior = priorShippedContent();
    harness.run(prior);

    // After the first run, the on-disk file is the new template. A second
    // run sees that and must no-op.
    const newContent = newTemplateContent();
    expect(fs.readFileSync(harness.scriptPath, 'utf-8')).toBe(newContent);

    const backupDir = path.join(harness.stateDir, 'backups');
    const before = fs.readdirSync(backupDir);

    // Run again — note the harness rewrites the script with whatever we
    // pass in, so we re-write the new content (simulating a no-op
    // double-run on an up-to-date install).
    const result2 = harness.run(newContent);

    // No new backup file.
    const after = fs.readdirSync(backupDir);
    expect(after).toEqual(before);
    // Result is a skip.
    expect(result2.upgraded).toHaveLength(0);
    expect(result2.skipped.some((s) => s.includes('already current'))).toBe(true);
  });
});
