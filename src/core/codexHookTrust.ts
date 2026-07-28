/**
 * codexHookTrust — read/verify Codex's per-hook trust state for instar's
 * project-scoped gate hooks. P0 of the codex-full-parity spec.
 *
 * WHY: Codex 0.133 runs a hook only if its content hash matches a `trusted_hash`
 * entry in `$CODEX_HOME/config.toml [hooks.state]`. instar writes its gates to the
 * agent's PROJECT `.codex/hooks.json`; the trust entries are keyed by that file's
 * path (`<hooks.json-path>:<event>:<group>:<idx>`), so arming them only affects
 * that agent's project — the operator's personal Codex (run from another cwd) never
 * loads them (G2 verdict, spec §P0). A freshly-init'd Codex agent has these UNtrusted
 * → its safety guards are dark until armed. This module is the read/verify half
 * (idempotency + post-arm readback); the arming spawn lives in codexHookArm.
 *
 * No TOML dependency (instar deliberately avoids one — see mcpToolRegistry). The
 * `[hooks.state]` block is simple enough to parse line-based for the specific
 * project-path-keyed entries we care about.
 */

export interface CodexHookTrustEntry {
  /** The full state key: `<hooks.json-path>:<event>:<group>:<idx>`. */
  key: string;
  /** `<event>:<group>:<idx>` portion (path-stripped). */
  slot: string;
  trustedHash: string | null;
  /** Codex omits `enabled` when true; an explicit `enabled = false` disables the hook. */
  enabled: boolean;
}

/**
 * Parse the `[hooks.state]` entries from a `config.toml` body that belong to a
 * specific hooks.json path. Returns one entry per `<event>:<group>:<idx>` slot.
 *
 * Matches the on-disk shape:
 *   [hooks.state."/abs/.codex/hooks.json:stop:0:0"]
 *   trusted_hash = "sha256:..."
 *   enabled = false        # only present when disabled
 */
export function parseCodexHookTrust(
  configTomlBody: string,
  hooksJsonPath: string,
): CodexHookTrustEntry[] {
  const entries: CodexHookTrustEntry[] = [];
  const lines = configTomlBody.split('\n');
  // A hooks.state header looks like: [hooks.state."<key>"]
  const headerRe = /^\s*\[hooks\.state\."(.+)"\]\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headerRe);
    if (!m) continue;
    const key = m[1];
    // Only entries for THIS project's hooks.json path.
    if (!key.startsWith(hooksJsonPath + ':')) continue;
    const slot = key.slice(hooksJsonPath.length + 1);
    let trustedHash: string | null = null;
    let enabled = true; // default: Codex omits the field when trusted+enabled
    // Scan the block body until the next header or blank-separated section.
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (headerRe.test(line) || /^\s*\[/.test(line)) break; // next table
      const th = line.match(/^\s*trusted_hash\s*=\s*"([^"]*)"\s*$/);
      if (th) trustedHash = th[1];
      const en = line.match(/^\s*enabled\s*=\s*(true|false)\s*$/);
      if (en) enabled = en[1] === 'true';
    }
    entries.push({ key, slot, trustedHash, enabled });
  }
  return entries;
}

/**
 * Idempotency check (F2): are ALL of the agent's project hooks trusted + enabled?
 * `expectedSlots` is the set of `<event>:<group>:<idx>` slots instar wrote into the
 * project hooks.json (derived from buildInstarCodexHookGroups). Returns the slots
 * that still need arming (untrusted) and the ones explicitly disabled (enabled=false,
 * which "trust all" does NOT clear — F3: never silently re-enable a user-disabled hook).
 */
export function codexHooksArmingStatus(
  configTomlBody: string,
  hooksJsonPath: string,
  expectedSlots: string[],
): { untrusted: string[]; disabled: string[]; allArmed: boolean } {
  const entries = parseCodexHookTrust(configTomlBody, hooksJsonPath);
  const bySlot = new Map(entries.map((e) => [e.slot, e]));
  const untrusted: string[] = [];
  const disabled: string[] = [];
  for (const slot of expectedSlots) {
    const e = bySlot.get(slot);
    if (!e || !e.trustedHash) {
      untrusted.push(slot);
    } else if (!e.enabled) {
      disabled.push(slot);
    }
  }
  return { untrusted, disabled, allArmed: untrusted.length === 0 && disabled.length === 0 };
}

/**
 * Derive the `<event>:<group>:<idx>` slots from a Codex hooks.json config object
 * (the shape buildInstarCodexHookGroups produces). Codex lowercases+snake_cases the
 * event for the state key (PreToolUse → pre_tool_use, etc.).
 */
const EVENT_TO_STATE_KEY: Record<string, string> = {
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact',
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Stop: 'stop',
};

export function expectedHookSlots(
  hooks: Record<string, Array<{ hooks?: unknown[] }>>,
): string[] {
  const slots: string[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    const stateEvent = EVENT_TO_STATE_KEY[event];
    if (!stateEvent) continue;
    (groups ?? []).forEach((group, groupIdx) => {
      const count = Array.isArray(group.hooks) ? group.hooks.length : 0;
      for (let hookIdx = 0; hookIdx < count; hookIdx++) {
        slots.push(`${stateEvent}:${groupIdx}:${hookIdx}`);
      }
    });
  }
  return slots;
}
