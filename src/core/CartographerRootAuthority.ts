/**
 * CartographerRootAuthority — inert root-selection and verification substrate.
 *
 * This module deliberately does not wire itself into Cartographer routes or the
 * freshness sweep. It separates three questions that the old projectDir
 * singleton collapsed:
 *
 *   1. Which root did a provenance-bearing source select?
 *   2. What repository identity and revision are actually present there?
 *   3. Which operations are safe at the resulting trust level?
 *
 * A selected directory without a readable Git HEAD remains useful for the
 * zero-cost structural hierarchy, but it is never eligible for paid authoring.
 * Contradictory evidence (for example an expected-remote mismatch) refuses the
 * root entirely. PR 11B-2 is the consumer boundary that will apply this contract
 * to live navigation, reporting, and authoring.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SafeGitExecutor } from './SafeGitExecutor.js';

export type CartographerRootKind =
  'agent-home' | 'active-project-checkout' | 'instar-source-checkout';

export type CartographerRootProvenance =
  | { source: 'agent-home'; agentName: string }
  | { source: 'server-project'; projectName: string }
  | { source: 'topic-binding'; topicId: number; projectName: string }
  | { source: 'operator-binding'; bindingId: string; projectName: string };

export interface CartographerRootCandidate {
  kind: CartographerRootKind;
  requestedPath: string;
  provenance: CartographerRootProvenance;
  /** Optional repository anchor supplied by the provenance source. */
  expectedRemote?: string;
  /** Optional exact revision anchor, primarily used for revalidation. */
  expectedRevision?: string;
}

export type CartographerRootSelectionRequest =
  | {
      kind: 'agent-home';
      agentHome: string;
      agentName: string;
    }
  | {
      kind: 'active-project-checkout';
      standalone: boolean;
      serverProject?: {
        projectDir: string;
        projectName: string;
        gitRemote?: string;
      };
      topicBinding?: {
        topicId: number;
        projectDir: string;
        projectName: string;
        gitRemote?: string;
      };
    }
  | {
      kind: 'instar-source-checkout';
      binding: {
        bindingId: string;
        projectDir: string;
        projectName: string;
        gitRemote: string;
      };
    };

export type CartographerRootSelectionResult =
  | { ok: true; candidate: CartographerRootCandidate }
  | {
      ok: false;
      code:
        | 'topic-binding-required'
        | 'server-project-required'
        | 'instar-source-binding-required';
      message: string;
    };

export type CartographerRootTrust = 'verified' | 'structural-only' | 'refused';

export type CartographerRootReason =
  | 'verified'
  | 'path-missing'
  | 'path-not-directory'
  | 'canonicalize-failed'
  | 'git-root-unreadable'
  | 'candidate-not-git-root'
  | 'head-unreadable'
  | 'instar-source-expectation-missing'
  | 'remote-unreadable'
  | 'remote-mismatch'
  | 'revision-mismatch'
  | 'root-identity-mismatch';

export interface CartographerRootIdentity {
  /** Stable for this checked-out root across revisions. */
  rootId: string;
  /** Stable repository identity derived from an anchored remote or common Git dir. */
  repositoryId: string | null;
  kind: CartographerRootKind;
  canonicalPath: string;
  gitTopLevel: string | null;
  remoteUrl: string | null;
  revision: string | null;
  /** Safe, opaque namespace for stateDir/cartographer/roots/<namespace>. */
  stateNamespace: string;
}

export interface CartographerRootAssessment {
  candidate: CartographerRootCandidate;
  trust: CartographerRootTrust;
  reason: CartographerRootReason;
  identity: CartographerRootIdentity | null;
  /** Structural population is zero-egress and survives missing Git identity. */
  structuralPopulationAllowed: boolean;
  /** Paid authoring requires a verified project/source checkout and exact readable revision. */
  paidAuthoringAllowed: boolean;
}

export interface CartographerRootDecisionSignals {
  pathState: 'unreadable' | 'file' | 'directory';
  canonicalPath: string | null;
  gitTopLevel: string | null;
  expectedRemote: string | null;
  observedRemotes: string[];
  expectedRevision: string | null;
  observedRevision: string | null;
}

/**
 * Structured evidence emitted for every authority outcome. The recorder is a
 * required dependency: a live consumer cannot obtain an allow/degrade/refuse
 * result without also accepting responsibility for its decision trail.
 */
export interface CartographerRootDecision {
  schemaVersion: 1;
  decidedAt: string;
  operation: 'assess' | 'revalidate';
  context: { candidate: CartographerRootCandidate };
  signals: CartographerRootDecisionSignals;
  rule: CartographerRootReason | 'revalidation-not-applicable';
  outcome: {
    trust: CartographerRootTrust;
    structuralPopulationAllowed: boolean;
    paidAuthoringAllowed: boolean;
    rootId: string | null;
    stateNamespace: string | null;
  };
}

export interface CartographerRootAuthorityOptions {
  /** Must durably record in a live consumer. Throwing prevents an unlogged outcome. */
  recordDecision: (decision: CartographerRootDecision) => void;
  now?: () => Date;
}

const GIT_OP = 'cartographer-root-authority';

/**
 * Select a candidate only from an explicit, typed provenance source.
 *
 * In particular, a standalone active-project request never falls back to the
 * agent home. That fallback is the wrong-root failure this contract exists to
 * remove. Instar source is explicit-only: directory scanning and marker files
 * may corroborate an identity later, but can never select it.
 */
export function selectCartographerRootCandidate(
  request: CartographerRootSelectionRequest,
): CartographerRootSelectionResult {
  if (request.kind === 'agent-home') {
    return {
      ok: true,
      candidate: {
        kind: request.kind,
        requestedPath: request.agentHome,
        provenance: { source: 'agent-home', agentName: request.agentName },
      },
    };
  }

  if (request.kind === 'instar-source-checkout') {
    if (!request.binding?.projectDir || !request.binding.gitRemote) {
      return {
        ok: false,
        code: 'instar-source-binding-required',
        message:
          'Instar source selection requires an explicit binding with a repository anchor',
      };
    }
    return {
      ok: true,
      candidate: {
        kind: request.kind,
        requestedPath: request.binding.projectDir,
        provenance: {
          source: 'operator-binding',
          bindingId: request.binding.bindingId,
          projectName: request.binding.projectName,
        },
        expectedRemote: request.binding.gitRemote,
      },
    };
  }

  if (request.topicBinding) {
    return {
      ok: true,
      candidate: {
        kind: request.kind,
        requestedPath: request.topicBinding.projectDir,
        provenance: {
          source: 'topic-binding',
          topicId: request.topicBinding.topicId,
          projectName: request.topicBinding.projectName,
        },
        expectedRemote: request.topicBinding.gitRemote,
      },
    };
  }

  if (request.standalone) {
    return {
      ok: false,
      code: 'topic-binding-required',
      message:
        'A standalone active-project root requires a topic-project binding',
    };
  }

  if (!request.serverProject) {
    return {
      ok: false,
      code: 'server-project-required',
      message:
        'A project-bound active-project root requires the server project declaration',
    };
  }

  return {
    ok: true,
    candidate: {
      kind: request.kind,
      requestedPath: request.serverProject.projectDir,
      provenance: {
        source: 'server-project',
        projectName: request.serverProject.projectName,
      },
      expectedRemote: request.serverProject.gitRemote,
    },
  };
}

/** Normalize common HTTPS, SSH, and scp-like Git remote spellings for identity comparison. */
export function normalizeCartographerGitRemote(raw: string): string {
  let value = raw.trim();
  while (value.endsWith('/')) value = value.slice(0, -1);
  if (/\.git$/i.test(value)) value = value.slice(0, -4);

  const normalizePath = (host: string, rawPath: string): string => {
    const clean = rawPath
      .replace(/^\/+/, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '');
    // github.com documents repository URLs as case-insensitive. Preserve path
    // case everywhere else: folding an unknown forge's path can collapse two
    // genuinely different repositories into one trusted identity.
    return host === 'github.com' ? clean.toLowerCase() : clean;
  };

  const scp = value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (scp && !value.includes('://')) {
    const host = scp[1].toLowerCase();
    return `${host}/${normalizePath(host, scp[2])}`;
  }

  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const pathname = normalizePath(host, parsed.pathname);
    if (parsed.protocol === 'file:') return `file:${pathname}`;
    const defaultPort =
      (parsed.protocol === 'ssh:' && parsed.port === '22') ||
      (parsed.protocol === 'git:' && parsed.port === '9418') ||
      (parsed.protocol === 'http:' && parsed.port === '80') ||
      (parsed.protocol === 'https:' && parsed.port === '443');
    const authority =
      parsed.port && !defaultPort ? `${host}:${parsed.port}` : host;
    return `${authority}/${pathname}`;
  } catch {
    // Unknown syntax is not safe to case-fold. Equality remains available for
    // byte-equivalent anchors without manufacturing false equivalence.
    return value;
  }
}

function digest(value: string, length = 24): string {
  return crypto
    .createHash('sha256')
    .update(value, 'utf8')
    .digest('hex')
    .slice(0, length);
}

function provenanceKey(provenance: CartographerRootProvenance): string {
  switch (provenance.source) {
    case 'agent-home':
      return `agent-home:${provenance.agentName}`;
    case 'server-project':
      return `server-project:${provenance.projectName}`;
    case 'topic-binding':
      return `topic-binding:${provenance.topicId}:${provenance.projectName}`;
    case 'operator-binding':
      return `operator-binding:${provenance.bindingId}:${provenance.projectName}`;
  }
}

function readGit(cwd: string, args: readonly string[]): string | null {
  try {
    // Root verification must work against the Instar source checkout itself.
    // SafeGitExecutor keeps this opt-in narrow: only its closed read-tier verb
    // allowlist bypasses SourceTreeGuard; a destructive/differently-shaped call
    // still cannot pass through this option.
    const value = SafeGitExecutor.readSync(args, {
      cwd,
      operation: GIT_OP,
      sourceTreeReadOk: true,
    }).trim();
    return value || null;
  } catch {
    return null; /* @silent-fallback-ok — unreadable Git evidence becomes a required structured authority decision */
  }
}

function readRemotes(
  cwd: string,
): Array<{ name: string; url: string; normalized: string }> {
  // `remote -v` is on SafeGitExecutor's source-tree read-tier allowlist, while
  // arbitrary config access intentionally is not. Parse fetch identities only:
  // a push-only URL proves write destination, not which repository was checked out.
  const raw = readGit(cwd, ['remote', '-v']);
  if (!raw) return [];
  const remotes: Array<{ name: string; url: string; normalized: string }> = [];
  for (const line of raw.split('\n')) {
    const match = line.match(/^(\S+)\s+(.+?)\s+\(fetch\)$/);
    if (!match) continue;
    const url = match[2].trim();
    if (!url) continue;
    remotes.push({
      name: match[1],
      url,
      normalized: normalizeCartographerGitRemote(url),
    });
  }
  return remotes;
}

function canonicalCommonGitDir(cwd: string): string | null {
  const raw = readGit(cwd, ['rev-parse', '--git-common-dir']);
  if (!raw) return null;
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return path.resolve(absolute);
  }
}

function identityFor(input: {
  candidate: CartographerRootCandidate;
  canonicalPath: string;
  gitTopLevel: string | null;
  remoteUrl: string | null;
  commonGitDir: string | null;
  revision: string | null;
}): CartographerRootIdentity {
  const remoteIdentity = input.remoteUrl
    ? `remote:${normalizeCartographerGitRemote(input.remoteUrl)}`
    : null;
  const repositoryBasis =
    remoteIdentity ??
    (input.commonGitDir ? `common-git-dir:${input.commonGitDir}` : null);
  const repositoryId = repositoryBasis ? digest(repositoryBasis) : null;
  const rootBasis = repositoryId
    ? `${input.candidate.kind}\0${repositoryId}\0${input.canonicalPath}`
    : `${input.candidate.kind}\0structural\0${provenanceKey(input.candidate.provenance)}\0${input.canonicalPath}`;
  const rootId = digest(rootBasis);
  return {
    rootId,
    repositoryId,
    kind: input.candidate.kind,
    canonicalPath: input.canonicalPath,
    gitTopLevel: input.gitTopLevel,
    remoteUrl: input.remoteUrl,
    revision: input.revision,
    stateNamespace: `root-${rootId}`,
  };
}

function refused(
  candidate: CartographerRootCandidate,
  reason: CartographerRootReason,
  identity: CartographerRootIdentity | null = null,
): CartographerRootAssessment {
  return {
    candidate,
    trust: 'refused',
    reason,
    identity,
    structuralPopulationAllowed: false,
    paidAuthoringAllowed: false,
  };
}

function structuralOnly(
  candidate: CartographerRootCandidate,
  reason: CartographerRootReason,
  identity: CartographerRootIdentity,
): CartographerRootAssessment {
  return {
    candidate,
    trust: 'structural-only',
    reason,
    identity,
    structuralPopulationAllowed: true,
    paidAuthoringAllowed: false,
  };
}

export class CartographerRootAuthority {
  private readonly recordDecision: (decision: CartographerRootDecision) => void;
  private readonly now: () => Date;

  constructor(options: CartographerRootAuthorityOptions) {
    this.recordDecision = options.recordDecision;
    this.now = options.now ?? (() => new Date());
  }

  private decide(
    assessment: CartographerRootAssessment,
    operation: 'assess' | 'revalidate',
    signals: CartographerRootDecisionSignals,
    rule: CartographerRootDecision['rule'] = assessment.reason,
  ): CartographerRootAssessment {
    // Do not return an authority outcome if its required audit sink fails. That
    // keeps the future live consumer from silently acting on an unlogged trust
    // decision and makes recorder availability part of the authority contract.
    this.recordDecision({
      schemaVersion: 1,
      decidedAt: this.now().toISOString(),
      operation,
      context: {
        candidate: {
          ...assessment.candidate,
          provenance: { ...assessment.candidate.provenance },
        },
      },
      signals: { ...signals, observedRemotes: [...signals.observedRemotes] },
      rule,
      outcome: {
        trust: assessment.trust,
        structuralPopulationAllowed: assessment.structuralPopulationAllowed,
        paidAuthoringAllowed: assessment.paidAuthoringAllowed,
        rootId: assessment.identity?.rootId ?? null,
        stateNamespace: assessment.identity?.stateNamespace ?? null,
      },
    });
    return assessment;
  }

  private evaluate(
    candidate: CartographerRootCandidate,
    operation: 'assess' | 'revalidate',
    expectedRootId?: string,
  ): CartographerRootAssessment {
    const signals: CartographerRootDecisionSignals = {
      pathState: 'unreadable',
      canonicalPath: null,
      gitTopLevel: null,
      expectedRemote: candidate.expectedRemote
        ? normalizeCartographerGitRemote(candidate.expectedRemote)
        : null,
      observedRemotes: [],
      expectedRevision: candidate.expectedRevision ?? null,
      observedRevision: null,
    };
    let stat: fs.Stats;
    try {
      stat = fs.statSync(candidate.requestedPath);
    } catch {
      return this.decide(
        refused(candidate, 'path-missing'),
        operation,
        signals,
      );
    }
    signals.pathState = stat.isDirectory() ? 'directory' : 'file';
    if (!stat.isDirectory()) {
      return this.decide(
        refused(candidate, 'path-not-directory'),
        operation,
        signals,
      );
    }

    let canonicalPath: string;
    try {
      canonicalPath = fs.realpathSync(candidate.requestedPath);
    } catch {
      return this.decide(
        refused(candidate, 'canonicalize-failed'),
        operation,
        signals,
      );
    }
    signals.canonicalPath = canonicalPath;

    const rawTopLevel = readGit(canonicalPath, [
      'rev-parse',
      '--show-toplevel',
    ]);
    if (!rawTopLevel) {
      return this.decide(
        structuralOnly(
          candidate,
          'git-root-unreadable',
          identityFor({
            candidate,
            canonicalPath,
            gitTopLevel: null,
            remoteUrl: null,
            commonGitDir: null,
            revision: null,
          }),
        ),
        operation,
        signals,
      );
    }

    let gitTopLevel: string;
    try {
      gitTopLevel = fs.realpathSync(rawTopLevel);
    } catch {
      return this.decide(
        structuralOnly(
          candidate,
          'git-root-unreadable',
          identityFor({
            candidate,
            canonicalPath,
            gitTopLevel: null,
            remoteUrl: null,
            commonGitDir: null,
            revision: null,
          }),
        ),
        operation,
        signals,
      );
    }
    signals.gitTopLevel = gitTopLevel;

    if (gitTopLevel !== canonicalPath) {
      return this.decide(
        refused(
          candidate,
          'candidate-not-git-root',
          identityFor({
            candidate,
            canonicalPath,
            gitTopLevel,
            remoteUrl: null,
            commonGitDir: canonicalCommonGitDir(gitTopLevel),
            revision: null,
          }),
        ),
        operation,
        signals,
      );
    }

    const remotes = readRemotes(canonicalPath);
    signals.observedRemotes = remotes.map((remote) => remote.normalized);
    const expectedRemote = signals.expectedRemote;
    const matchedRemote = expectedRemote
      ? (remotes.find((remote) => remote.normalized === expectedRemote) ?? null)
      : (remotes.find((remote) => remote.name === 'origin') ??
        remotes[0] ??
        null);
    const commonGitDir = canonicalCommonGitDir(canonicalPath);
    const revision = readGit(canonicalPath, ['rev-parse', 'HEAD']);
    signals.observedRevision = revision;

    const provisionalIdentity = identityFor({
      candidate,
      canonicalPath,
      gitTopLevel,
      remoteUrl: matchedRemote?.url ?? null,
      commonGitDir,
      revision,
    });

    if (candidate.kind === 'instar-source-checkout' && !expectedRemote) {
      return this.decide(
        structuralOnly(
          candidate,
          'instar-source-expectation-missing',
          provisionalIdentity,
        ),
        operation,
        signals,
      );
    }
    if (expectedRemote && remotes.length === 0) {
      return this.decide(
        structuralOnly(candidate, 'remote-unreadable', provisionalIdentity),
        operation,
        signals,
      );
    }
    if (expectedRemote && !matchedRemote) {
      const actualIdentity = identityFor({
        candidate,
        canonicalPath,
        gitTopLevel,
        remoteUrl:
          remotes.find((remote) => remote.name === 'origin')?.url ??
          remotes[0]?.url ??
          null,
        commonGitDir,
        revision,
      });
      return this.decide(
        refused(candidate, 'remote-mismatch', actualIdentity),
        operation,
        signals,
      );
    }
    if (!revision) {
      return this.decide(
        structuralOnly(candidate, 'head-unreadable', provisionalIdentity),
        operation,
        signals,
      );
    }
    if (candidate.expectedRevision && revision !== candidate.expectedRevision) {
      return this.decide(
        refused(candidate, 'revision-mismatch', provisionalIdentity),
        operation,
        signals,
      );
    }
    if (expectedRootId && provisionalIdentity.rootId !== expectedRootId) {
      return this.decide(
        refused(candidate, 'root-identity-mismatch', provisionalIdentity),
        operation,
        signals,
      );
    }

    return this.decide(
      {
        candidate,
        trust: 'verified',
        reason: 'verified',
        identity: provisionalIdentity,
        structuralPopulationAllowed: true,
        // Agent home is an identity/state container, not an active project. Even
        // when it is itself a valid Git repository, selecting it explicitly must
        // not authorize the noisy-home paid sweep that exposed this failure.
        paidAuthoringAllowed: candidate.kind !== 'agent-home',
      },
      operation,
      signals,
    );
  }

  assess(candidate: CartographerRootCandidate): CartographerRootAssessment {
    return this.evaluate(candidate, 'assess');
  }

  /** Revalidate the same root identity and exact revision before a trusted operation. */
  revalidate(
    assessment: CartographerRootAssessment,
  ): CartographerRootAssessment {
    if (assessment.trust !== 'verified' || !assessment.identity?.revision) {
      return this.decide(
        assessment,
        'revalidate',
        {
          pathState: assessment.identity ? 'directory' : 'unreadable',
          canonicalPath: assessment.identity?.canonicalPath ?? null,
          gitTopLevel: assessment.identity?.gitTopLevel ?? null,
          expectedRemote: assessment.candidate.expectedRemote
            ? normalizeCartographerGitRemote(
                assessment.candidate.expectedRemote,
              )
            : null,
          observedRemotes: assessment.identity?.remoteUrl
            ? [normalizeCartographerGitRemote(assessment.identity.remoteUrl)]
            : [],
          expectedRevision: assessment.identity?.revision ?? null,
          observedRevision: assessment.identity?.revision ?? null,
        },
        'revalidation-not-applicable',
      );
    }
    return this.evaluate(
      {
        ...assessment.candidate,
        expectedRevision: assessment.identity.revision,
      },
      'revalidate',
      assessment.identity.rootId,
    );
  }
}
