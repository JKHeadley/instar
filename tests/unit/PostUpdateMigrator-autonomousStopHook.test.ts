// safe-git-allow: reads two immutable historical hook blobs to prove exact-hash migration.
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
import { execFileSync } from 'node:child_process';
import {
  AUTONOMOUS_STOP_HOOK_STOCK_SHA256,
  PostUpdateMigrator,
} from '../../src/core/PostUpdateMigrator.js';
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

// A stock-looking but unknown hook layout. The old migration treated the
// human-readable header as proof this was stock and overwrote the whole file.
// It is deliberately unsafe to do that: customized derivatives retain headers.
const STOCK_HEADER_UNKNOWN_LAYOUT = `#!/bin/bash
# Autonomous Mode Stop Hook
# operator customization: do not erase
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

function priorStateParseHook(): string {
  const bundled = fs.readFileSync(
    path.join(process.cwd(), '.claude', 'skills', 'autonomous', 'hooks', 'autonomous-stop-hook.sh'),
    'utf8',
  );
  return bundled
    .replace(
      `# hook-capability: STATE_PARSE_LOUD — a selected state file with missing/malformed
# frontmatter is a visible hook failure, distinct from the clean no-state exit.
`,
      '',
    )
    .replace(
      `# STATE_FILE was selected only after an existence check. From this point on,
# "no parseable state" is corruption, NOT the same outcome as "no autonomous
# job". The API reader accepts plain key lines anywhere in the document, while
# this hook intentionally consumes fenced frontmatter. A missing/partial fence
# must therefore fail visibly instead of turning an active run into exit 0.
state_parse_failure() {
  printf 'ERROR: Autonomous mode: autonomous state exists but its frontmatter is unparseable: %s (expected a fenced block with active: true|false)\\n' "$STATE_FILE" >&2
  exit 1
}

FM_DELIMITER_COUNT=$(awk '$0 == "---" { count++ } END { print count + 0 }' "$STATE_FILE" 2>/dev/null)
FM_DELIMITER_COUNT="\${FM_DELIMITER_COUNT:-0}"
if [[ "$FM_DELIMITER_COUNT" -lt 2 ]]; then
  state_parse_failure
fi

`,
      '',
    )
    .replace(
      `if [[ "$ACTIVE" != "true" ]] && [[ "$ACTIVE" != "false" ]]; then
  state_parse_failure
fi
`,
      '',
    );
}

const HISTORICAL_STOCK_HOOKS = [
  {
    label: 'original session-keyed stock hook',
    commit: 'f74b8086f6bb88b1b2aaa2c17d0ca39f70423fca',
    sha256: 'fbb68b9d14465315653ebe597ec0f62d0846afbc3f59364a0fcc6657eeeddee1',
  },
  {
    label: 'topic-keyed v1.2.55-era stock hook',
    commit: 'c7f95344e7d7a43104cc2a37a0ab92bbd97eb78e',
    sha256: '972574c945ee1d43335970fab4512269d3e5e9f9afe92a13f94c99ebffba7391',
  },
] as const;

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

  it('surgically upgrades the immediately prior stock hook to visible state-parse failure', () => {
    const dst = deployHook(projectDir, priorStateParseHook());
    expect(fs.readFileSync(dst, 'utf8')).not.toContain('STATE_PARSE_LOUD');

    const result = runMigration(newMigrator(projectDir));

    const updated = fs.readFileSync(dst, 'utf8');
    expect(updated).toContain('STATE_PARSE_LOUD');
    expect(updated).toContain('state_parse_failure');
    expect(updated).toContain('FM_DELIMITER_COUNT');
    expect((fs.statSync(dst).mode & 0o111)).not.toBe(0); // executable
    expect(result.upgraded.some(u => u.includes('autonomous-stop-hook.sh'))).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('is idempotent — a second run makes no change and reports nothing', () => {
    deployHook(projectDir, priorStateParseHook());
    runMigration(newMigrator(projectDir)); // first run upgrades

    const dst = path.join(projectDir, HOOK_REL);
    const afterFirst = fs.readFileSync(dst, 'utf8');

    const second = runMigration(newMigrator(projectDir));
    expect(fs.readFileSync(dst, 'utf8')).toBe(afterFirst); // unchanged
    expect(second.upgraded.some(u => u.includes('autonomous-stop-hook.sh'))).toBe(false);
    expect(second.errors).toEqual([]);
  });

  it('leaves a customized hook untouched when the exact patch anchors are absent', () => {
    const custom = '#!/bin/bash\n# My heavily customized hook\nexit 0\n';
    const dst = deployHook(projectDir, custom);

    const result = runMigration(newMigrator(projectDir));

    expect(fs.readFileSync(dst, 'utf8')).toBe(custom); // untouched
    expect(result.skipped.some(s => s.includes('customized'))).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('refuses a customized hook that retains the stock header but lacks exact patch anchors', () => {
    const dst = deployHook(projectDir, STOCK_HEADER_UNKNOWN_LAYOUT);

    const result = runMigration(newMigrator(projectDir));

    expect(fs.readFileSync(dst, 'utf8')).toBe(STOCK_HEADER_UNKNOWN_LAYOUT);
    expect(result.skipped.some(s => s.includes('unknown layout'))).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('preserves stock-derived customization while surgically adding the validator', () => {
    const customLine = '# operator customization: retain this exact line';
    const priorCustomized = priorStateParseHook().replace(
      'set -uo pipefail',
      `${customLine}\nset -uo pipefail`,
    );
    const dst = deployHook(projectDir, priorCustomized);

    const result = runMigration(newMigrator(projectDir));
    const updated = fs.readFileSync(dst, 'utf8');

    expect(updated).toContain(customLine);
    expect(updated).toContain('STATE_PARSE_LOUD');
    expect(updated).toContain('state_parse_failure');
    expect(result.upgraded.some(u => u.includes('autonomous-stop-hook.sh'))).toBe(true);
    expect(result.errors).toEqual([]);
  });

  for (const historical of HISTORICAL_STOCK_HOOKS) {
    it(`upgrades the exact ${historical.label} by canonical content hash`, () => {
      expect(AUTONOMOUS_STOP_HOOK_STOCK_SHA256).toContain(historical.sha256);
      const oldStock = execFileSync(
        'git',
        ['show', `${historical.commit}:.claude/skills/autonomous/hooks/autonomous-stop-hook.sh`],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      const dst = deployHook(projectDir, oldStock);

      const result = runMigration(newMigrator(projectDir));
      const updated = fs.readFileSync(dst, 'utf8');

      expect(updated).toContain('STATE_PARSE_LOUD');
      expect(updated).toContain('state_parse_failure');
      expect(updated).toContain('MULTI-SESSION (per-topic state)');
      expect(() => execFileSync('bash', ['-n', dst])).not.toThrow();
      expect(result.upgraded.some(u => u.includes('autonomous-stop-hook.sh'))).toBe(true);
      expect(result.errors).toEqual([]);
    });
  }

  it('is a no-op when no hook is deployed (fresh installs handled by init)', () => {
    const result = runMigration(newMigrator(projectDir));
    expect(fs.existsSync(path.join(projectDir, HOOK_REL))).toBe(false);
    expect(result.upgraded).toEqual([]);
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
    // Upgrade-message text tracks the CURRENT marker bump (REALCHECK_VERIFY →
    // SCOPE_ACCRETION, autonomous-scope-accretion-completion.md §4).
    expect(result.upgraded.some(u => u.includes('SKILL.md') && u.includes('scope-accretion'))).toBe(true);
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
