/**
 * Verifies PostUpdateMigrator upgrades an already-deployed autonomous stop hook
 * to the topic-keyed version on update.
 *
 * installAutonomousSkill() is install-if-missing, so existing agents never get
 * hook updates through init. Without this migration, every agent deployed before
 * the topic-keying fix would keep running the buggy session-UUID-keyed hook —
 * the exact silent-failure this work fixes. The migration is the only path that
 * reaches already-installed copies (Migration Parity Standard).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const HOOK_REL = path.join('.claude', 'skills', 'autonomous', 'hooks', 'autonomous-stop-hook.sh');
const SETUP_REL = path.join('.claude', 'skills', 'autonomous', 'scripts', 'setup-autonomous.sh');
const SKILL_REL = path.join('.claude', 'skills', 'autonomous', 'SKILL.md');

// A prior-version SKILL.md: carries the stock fingerprint (`ALL_TASKS_COMPLETE`) and the
// previous per-topic marker, but LACKS the new `LEGITIMATE_STOP_CONDITIONS` section sentinel.
// Under the old marker this would be SKIPPED as current; after the marker bump it must be
// re-deployed so existing agents get the Legitimate Stop Conditions section.
const PRIOR_SKILL_MD = `---
name: autonomous
---

# Autonomous Mode (Structurally Enforced)

The completion promise is "ALL_TASKS_COMPLETE".

## Step 2b: Write the state file DIRECTLY
**WHY PER-TOPIC (setup-race hardening):** the stop hook reads this per-topic file directly.
`;

function deploySkill(projectDir: string, content: string): string {
  const dst = path.join(projectDir, SKILL_REL);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, content);
  return dst;
}

// A representative OLD (session-UUID-keyed) hook: carries the stock fingerprint
// but lacks the topic-session-registry marker.
const OLD_HOOK = `#!/bin/bash

# Autonomous Mode Stop Hook
# Prevents session exit when autonomous mode is active.

STATE_FILE=".instar/autonomous-state.local.md"
STATE_SESSION=$(echo "$FRONTMATTER" | grep '^session_id:')
if [[ "$STATE_SESSION" != "$HOOK_SESSION" ]]; then
  exit 0
fi
rm "$STATE_FILE"
`;

// A v1.2.55 topic-keyed hook: has topic-session-registry but NOT the
// multi-session marker — must still be upgraded.
const TOPIC_KEYED_V1255_HOOK = `#!/bin/bash
# Autonomous Mode Stop Hook
# TOPIC-KEYED OWNERSHIP ...
REGISTRY_FILE=".instar/topic-session-registry.json"
exit 0
`;

// An old setup script: writes the single legacy state file, lacks the per-topic marker.
const OLD_SETUP = `#!/bin/bash
# setup-autonomous.sh
cat > .instar/autonomous-state.local.md <<EOF
active: true
EOF
`;

// A prior-version setup that ALREADY has native /goal (the prior marker 'native-goal/set')
// but NOT the codex native-/goal auto-wire ('IS_CODEX_AGENT'). Carries the stock fingerprint
// ('autonomous-state.local.md'). Under the old marker this would be SKIPPED as current; after
// the marker bump it must be re-deployed so codex agents get native /goal auto-delegation.
const PRIOR_NATIVE_GOAL_SETUP = `#!/bin/bash
# setup-autonomous.sh — legacy fallback is .instar/autonomous-state.local.md
STATE_PATH=".instar/autonomous/\${REPORT_TOPIC}.local.md"
# native /goal delegation (Claude only, gated on claude --version)
curl -s --data-binary @- "http://localhost:4040/autonomous/native-goal/set" >/dev/null 2>&1
`;

function deploySetup(projectDir: string, content: string): string {
  const dst = path.join(projectDir, SETUP_REL);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, content);
  return dst;
}

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function runMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as {
    migrateAutonomousStopHookTopicKeyed(r: MigrationResult): void;
  }).migrateAutonomousStopHookTopicKeyed(result);
  return result;
}

function deployHook(projectDir: string, content: string): string {
  const dst = path.join(projectDir, HOOK_REL);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, content);
  return dst;
}

describe('PostUpdateMigrator — autonomous stop hook topic-keying', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-auto-hook-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true, force: true,
      operation: 'tests/unit/PostUpdateMigrator-autonomousStopHook.test.ts',
    });
  });

  it('upgrades an old session-keyed hook to the topic-keyed version', () => {
    const dst = deployHook(projectDir, OLD_HOOK);
    expect(fs.readFileSync(dst, 'utf8')).not.toContain('topic-session-registry');

    const result = runMigration(newMigrator(projectDir));

    const updated = fs.readFileSync(dst, 'utf8');
    expect(updated).toContain('topic-session-registry'); // now topic-keyed
    expect(updated).toContain('TOPIC-KEYED OWNERSHIP');
    expect((fs.statSync(dst).mode & 0o111)).not.toBe(0); // executable
    expect(result.upgraded.some(u => u.includes('autonomous-stop-hook.sh'))).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('is idempotent — a second run makes no change and reports nothing', () => {
    deployHook(projectDir, OLD_HOOK);
    runMigration(newMigrator(projectDir)); // first run upgrades

    const dst = path.join(projectDir, HOOK_REL);
    const afterFirst = fs.readFileSync(dst, 'utf8');

    const second = runMigration(newMigrator(projectDir));
    expect(fs.readFileSync(dst, 'utf8')).toBe(afterFirst); // unchanged
    expect(second.upgraded.some(u => u.includes('autonomous-stop-hook.sh'))).toBe(false);
    expect(second.errors).toEqual([]);
  });

  it('leaves a customized hook untouched (no stock fingerprint)', () => {
    const custom = '#!/bin/bash\n# My heavily customized hook\nexit 0\n';
    const dst = deployHook(projectDir, custom);

    const result = runMigration(newMigrator(projectDir));

    expect(fs.readFileSync(dst, 'utf8')).toBe(custom); // untouched
    expect(result.skipped.some(s => s.includes('customized'))).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('is a no-op when no hook is deployed (fresh installs handled by init)', () => {
    const result = runMigration(newMigrator(projectDir));
    expect(fs.existsSync(path.join(projectDir, HOOK_REL))).toBe(false);
    expect(result.upgraded).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('upgrades a v1.2.55 topic-keyed hook to multi-session (per-topic state)', () => {
    const dst = deployHook(projectDir, TOPIC_KEYED_V1255_HOOK);
    expect(fs.readFileSync(dst, 'utf8')).not.toContain('MULTI-SESSION (per-topic state)');

    const result = runMigration(newMigrator(projectDir));

    const updated = fs.readFileSync(dst, 'utf8');
    expect(updated).toContain('MULTI-SESSION (per-topic state)'); // now multi-session
    expect(result.upgraded.some(u => u.includes('autonomous-stop-hook.sh'))).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('upgrades an old setup-autonomous.sh to the per-topic state path', () => {
    const dst = deploySetup(projectDir, OLD_SETUP);
    expect(fs.readFileSync(dst, 'utf8')).not.toContain('.instar/autonomous/');

    const result = runMigration(newMigrator(projectDir));

    const updated = fs.readFileSync(dst, 'utf8');
    expect(updated).toContain('STATE_PATH=".instar/autonomous/'); // per-topic path
    expect(result.upgraded.some(u => u.includes('setup-autonomous.sh'))).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('re-deploys a prior native-/goal setup so codex agents get native /goal auto-wire (#40 marker bump)', () => {
    // Prior version carries the old marker `native-goal/set` (Claude-only native /goal) but
    // not `IS_CODEX_AGENT` — under the old marker it would be wrongly skipped as current.
    const dst = deploySetup(projectDir, PRIOR_NATIVE_GOAL_SETUP);
    const before = fs.readFileSync(dst, 'utf8');
    expect(before).toContain('native-goal/set');
    expect(before).not.toContain('IS_CODEX_AGENT');

    const result = runMigration(newMigrator(projectDir));

    const updated = fs.readFileSync(dst, 'utf8');
    expect(updated).toContain('IS_CODEX_AGENT');           // codex native /goal auto-wire present
    expect(updated).toContain("'codex-cli' in");            // detects codex via enabledFrameworks
    expect((fs.statSync(dst).mode & 0o111)).not.toBe(0);    // executable
    expect(result.upgraded.some(u => u.includes('setup-autonomous.sh'))).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('re-deploys a prior SKILL.md so existing agents get the completion-condition default + honest-exit marker', () => {
    // Prior SKILL.md carries the stock fingerprint + the per-topic marker but NOT the new
    // `COMPLETION_CONDITION_DEFAULT` sentinel — under the old marker it would be wrongly skipped.
    const dst = deploySkill(projectDir, PRIOR_SKILL_MD);
    const before = fs.readFileSync(dst, 'utf8');
    expect(before).toContain('ALL_TASKS_COMPLETE');         // stock fingerprint
    expect(before).not.toContain('COMPLETION_CONDITION_DEFAULT');

    const result = runMigration(newMigrator(projectDir));

    const updated = fs.readFileSync(dst, 'utf8');
    expect(updated).toContain('COMPLETION_CONDITION_DEFAULT');          // new section sentinel present
    expect(updated).toContain('## Legitimate Stop Conditions');        // human-readable header (carried forward)
    expect(updated).toContain('completion_condition');                 // the new default field
    expect(updated).toContain('hard_blocker_nonce');                   // the (a) exit nonce
    expect(result.upgraded.some(u => u.includes('SKILL.md') && u.includes('completion-condition default'))).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('is idempotent on SKILL.md — a second run makes no change and reports nothing', () => {
    deploySkill(projectDir, PRIOR_SKILL_MD);
    runMigration(newMigrator(projectDir)); // first run upgrades

    const dst = path.join(projectDir, SKILL_REL);
    const afterFirst = fs.readFileSync(dst, 'utf8');
    expect(afterFirst).toContain('COMPLETION_CONDITION_DEFAULT');

    const second = runMigration(newMigrator(projectDir));
    expect(fs.readFileSync(dst, 'utf8')).toBe(afterFirst); // unchanged
    expect(second.upgraded.some(u => u.includes('SKILL.md'))).toBe(false);
    expect(second.errors).toEqual([]);
  });

  it('leaves a customized SKILL.md untouched (no stock fingerprint)', () => {
    const custom = '---\nname: autonomous\n---\n# My heavily customized autonomous skill\n';
    const dst = deploySkill(projectDir, custom);

    const result = runMigration(newMigrator(projectDir));

    expect(fs.readFileSync(dst, 'utf8')).toBe(custom); // untouched
    expect(result.skipped.some(s => s.includes('SKILL.md') && s.includes('customized'))).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('is a no-op when no SKILL.md is deployed (fresh installs handled by init)', () => {
    const result = runMigration(newMigrator(projectDir));
    expect(fs.existsSync(path.join(projectDir, SKILL_REL))).toBe(false);
    expect(result.upgraded.some(u => u.includes('SKILL.md'))).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it('is wired into the full migration run() sequence', () => {
    // Guards against the migration existing but never being called (dead code).
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src', 'core', 'PostUpdateMigrator.ts'), 'utf8',
    );
    expect(src).toContain('this.migrateAutonomousStopHookTopicKeyed(result);');
  });
});
