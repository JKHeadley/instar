/**
 * Effect kinds (trust-journey spec, decision 2 and section 6a): the server-owned table that says
 * what a tool call physically does. The server, never the hook or the calling session, derives the
 * kind (`service.operation`), the account, the audience and the floor items from `tool_name` and
 * `tool_input`. A caller-supplied classification can only narrow.
 *
 * Scope (stage 0): exactly the effects that reach the external-operation gate today, the MCP tools
 * the generated hook intercepts (`mcp__<service>__<action>`). Each call is classified by the same
 * verb rules the hook used, now held on the server, refined by explicit entries below. Unknown
 * scope (no audience rule) asks, but only for a governed kind; a kind with an unchanged legacy grant
 * keeps today's behaviour whether or not the table matches it.
 */
import crypto from 'node:crypto';

export type EffectOperation = 'read' | 'write' | 'modify' | 'delete' | 'sign-in';
export type Reversibility = 'reversible' | 'partially-reversible' | 'irreversible';

/** The Purpose's always-ask items a table entry can name (spec section 2). */
export type FloorItem = 'speaks-publicly' | 'widens-role' | 'irreversible-outside-role';

export interface EffectEntry {
  /** The MCP service segment (`mcp__<service>__...`). */
  service: string;
  /** Exact action names (after the service segment) this entry covers. */
  actions: string[];
  operation: EffectOperation;
  reversibility?: Reversibility;
  /** Input fields that name the recipients; absent means the effect has no recipient (`self`). */
  audienceFields?: string[];
  /** True when the effect has no recipient at all. */
  selfOnly?: boolean;
  floor?: FloorItem[];
}

/** Exact registered tools refine the generic verb rules. Reads require no legacy grant migration. */
export const EFFECT_ENTRIES: readonly EffectEntry[] = [
  { service: 'threadline', actions: ['threadline_agents', 'threadline_discover'], operation: 'read', selfOnly: true },
];

/**
 * Decision 15, sign-in: on the Playwright MCP server (the browser tools today's gate intercepts),
 * typing into or filling a field whose description names a password, passcode or one-time code is
 * signing in with a stored credential. It only ever turns a call into the stricter, always-governed
 * sign-in kind; it never admits anything.
 */
function isSignIn(service: string, action: string, input: Record<string, unknown>): boolean {
  if (service !== 'playwright' || (action !== 'browser_type' && action !== 'browser_fill_form')) return false;
  // The description is the agent's own wording, so the net is wide; a code-driven fill (browser_evaluate,
  // browser_run_code) is not caught here and stays a governed modify.
  const credentialField = /pass(word|code|phrase|key)|one[- ]time|recovery code|backup code|security code|verification code|\bpin\b|\b2fa\b|\bmfa\b|\botp\b|\btotp\b|contrase|mot de passe|passwort|senha/i;
  const describe = (f: unknown) => (f && typeof f === 'object' ? `${(f as Record<string, unknown>).name ?? ''} ${(f as Record<string, unknown>).element ?? ''} ${(f as Record<string, unknown>).type ?? ''}` : '');
  if (action === 'browser_type') return credentialField.test(describe(input));
  return Array.isArray(input.fields) && input.fields.some((f) => credentialField.test(describe(f)));
}

/** Instar's own internal services: not person kinds (spec decision 9). A code constant, never config. */
export const SYSTEM_SERVICES: readonly string[] = ['parity-sentinel'];

export interface DerivedEffect {
  toolName: string;
  service: string;
  action: string;
  operation: EffectOperation;
  reversibility: Reversibility;
  itemCount: number;
  /** `service.operation`: the grant key, and `ApprovalLedger.decisionClass`. */
  kind: string;
  /** `self`, a sorted recipient list, or `unknown` (no audience rule). */
  audience: 'self' | 'unknown' | string[];
  floor: FloorItem[];
  /** True when an explicit table entry matched (not only the verb rules). */
  matched: boolean;
  /** Stable identity of this exact action: tool name plus canonical input. */
  actionIdentity: string;
}

const canonical = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
};

export function actionIdentityOf(toolName: string, toolInput: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify({ toolName, input: canonical(toolInput ?? {}) })).digest('hex');
}

/** The hook's verb rules, now held by the server (the hook keeps a copy only for its read fast path). */
export function verbRules(action: string): { operation: EffectOperation; reversibility: Reversibility } {
  const tokens = action.split('_').filter(Boolean);
  // Connector namespaces can precede the actual verb (github__fetch_pr or github_fetch_pr).
  // Match whole tokens, never a service/engine allowlist or a substring such as "fetcher".
  // A mutation or execution wrapper anywhere keeps a compound tool governed.
  const mutatingPart = tokens.some((t) => /^(delete|remove|trash|purge|destroy|drop|clear|send|create|post|write|add|insert|new|compose|publish|update|modify|edit|replace|patch|rename|move|change|set|toggle|enable|disable|revoke|archive|flush|wipe|expunge|push|comment|merge|execute|run|call|invoke|eval|evaluate)$/.test(t));
  // With explicit __ namespaces the final segment is the tool. In the flattened
  // spelling recognize the observed GitHub connector alias only. An arbitrary
  // unknown first word (inspect_read, launch_get_status) is NOT a namespace.
  const segments = action.split('__');
  const toolTokens = segments[segments.length - 1].split('_').filter(Boolean);
  const readVerb = /^(get|list|search|fetch|check|read|view|describe|show|count|query|find|status)$/;
  const hasReadVerb = readVerb.test(toolTokens[0] ?? '')
    || (segments.length === 1 && toolTokens[0] === 'github' && readVerb.test(toolTokens[1] ?? ''));
  let operation: EffectOperation = 'modify';
  if (/^(delete|remove|trash|purge|destroy|drop|clear)/.test(action)) operation = 'delete';
  else if (/^(send|create|post|write|add|insert|new|compose|publish)/.test(action)) operation = 'write';
  else if (/^(update|modify|edit|patch|rename|move|change|set|toggle|enable|disable)/.test(action)) operation = 'modify';
  else if (!mutatingPart && hasReadVerb) operation = 'read';
  let reversibility: Reversibility = 'reversible';
  if (/^(send|publish|post|destroy|purge|drop)/.test(action)) reversibility = 'irreversible';
  else if (/^(delete|remove|trash)/.test(action)) reversibility = 'partially-reversible';
  return { operation, reversibility };
}

const recipients = (input: Record<string, unknown>, fields: string[]): string[] | 'unknown' => {
  const out: string[] = [];
  for (const f of fields) {
    const v = input[f];
    if (v === undefined || v === null || v === '') continue;
    const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;]/) : null;
    if (!list) return 'unknown';
    for (const x of list) {
      if (typeof x !== 'string' || !x.trim()) return 'unknown';
      out.push(x.trim().toLowerCase());
    }
  }
  return out.length ? [...new Set(out)].sort() : 'unknown';
};

/** Derives the effect of one MCP tool call, or null when the tool is not an intercepted MCP tool. */
export function deriveEffect(toolName: string, toolInput: unknown): DerivedEffect | null {
  if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return null;
  const parts = toolName.split('__');
  if (parts.length < 3) return null;
  const service = parts[1];
  const action = parts.slice(2).join('_');
  const input = (toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput) ? toolInput : {}) as Record<string, unknown>;
  let itemCount = 1;
  for (const v of Object.values(input)) if (Array.isArray(v)) itemCount = Math.max(itemCount, v.length);
  const entry = parts.length === 3
    ? EFFECT_ENTRIES.find((e) => e.service === service && e.actions.includes(action))
    : undefined;
  const rules = verbRules(parts.slice(2).join('__'));
  const signIn = isSignIn(service, action, input);
  const operation: EffectOperation = signIn ? 'sign-in' : (entry?.operation ?? rules.operation);
  const reversibility = entry?.reversibility ?? rules.reversibility;
  let audience: DerivedEffect['audience'] = 'unknown';
  if (entry?.selfOnly || signIn) audience = 'self';
  else if (entry?.audienceFields) audience = recipients(input, entry.audienceFields);
  return {
    toolName, service, action, operation, reversibility, itemCount,
    kind: `${service}.${operation}`,
    audience,
    floor: [...(entry?.floor ?? [])],
    matched: !!entry || signIn,
    actionIdentity: actionIdentityOf(toolName, input),
  };
}

/** Exact tool names the table marks as reads, per service (written into the hook's fallback file). */
export function readToolNames(service: string): string[] {
  return EFFECT_ENTRIES.filter((e) => e.service === service && e.operation === 'read').flatMap((e) => e.actions.map((a) => `mcp__${service}__${a}`));
}
