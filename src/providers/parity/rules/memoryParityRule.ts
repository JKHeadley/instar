/**
 * memoryParityRule — parity rule for the Memory functional primitive.
 *
 * Specs:
 *   - specs/instar-concepts/memory.md (canonical shape)
 *   - specs/frameworks/claude-code/memory.md
 *   - specs/frameworks/codex-cli/memory.md
 *
 * Memory is substrate-bound: the canonical artifacts (`.instar/AGENT.md`,
 * `.instar/USER.md`, `.instar/MEMORY.md`, `.instar/state/topic-memory.sqlite`)
 * are framework-agnostic files on disk. This rule's verify() confirms each
 * required artifact is present, non-empty, and (for markdown) parses cleanly.
 *
 * v0.1 deliberately does NOT auto-remediate. Memory contains agent identity
 * and accumulated learnings — silent regeneration would erase intentional
 * drift. remediate() throws with a structured detail pointing to the documented
 * repair procedure.
 *
 * Loading canonical Memory into framework system-prompts (CLAUDE.md / AGENTS.md
 * references) is the InstructionFile primitive's responsibility — separate.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { IntelligenceFramework } from '../../../core/intelligenceProviderFactory.js';
import type {
  ParityRule,
  ParityMismatch,
  VerifyResult,
} from '../types.js';

interface MemoryArtifact {
  /** Path relative to projectRoot */
  relPath: string;
  /** How to validate this artifact */
  kind: 'markdown' | 'sqlite';
  /** Whether absence is a hard failure or a soft warning */
  required: boolean;
  /** Short label for error messages */
  label: string;
}

const ARTIFACTS: ReadonlyArray<MemoryArtifact> = [
  {
    relPath: '.instar/AGENT.md',
    kind: 'markdown',
    required: true,
    label: 'agent identity',
  },
  {
    relPath: '.instar/USER.md',
    kind: 'markdown',
    required: true,
    label: 'user profile',
  },
  {
    relPath: '.instar/MEMORY.md',
    kind: 'markdown',
    required: true,
    label: 'persistent learnings',
  },
  {
    relPath: '.instar/state/topic-memory.sqlite',
    kind: 'sqlite',
    required: false,
    label: 'topic memory store',
  },
];

const SQLITE_MAGIC = 'SQLite format 3\0';

class CanonicalMemoryError extends Error {
  readonly artifact: string;
  readonly reasonCode: ParityMismatch['reasonCode'];
  constructor(
    artifact: string,
    reasonCode: ParityMismatch['reasonCode'],
    message: string,
  ) {
    super(message);
    this.name = 'CanonicalMemoryError';
    this.artifact = artifact;
    this.reasonCode = reasonCode;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function verifyMarkdownArtifact(
  absPath: string,
  artifact: MemoryArtifact,
): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(absPath, 'utf-8');
  } catch (err) {
    throw new CanonicalMemoryError(
      artifact.relPath,
      'canonical-read-error',
      `cannot read ${artifact.label} at ${artifact.relPath}: ${(err as Error).message}`,
    );
  }
  if (raw.trim().length === 0) {
    throw new CanonicalMemoryError(
      artifact.relPath,
      'canonical-read-error',
      `${artifact.label} at ${artifact.relPath} is empty — repair required`,
    );
  }
  // Optional frontmatter — if it starts with `---`, parse it. If it doesn't,
  // that's fine (USER.md / MEMORY.md often have no frontmatter).
  if (raw.startsWith('---\n')) {
    const close = raw.indexOf('\n---', 4);
    if (close < 0) {
      throw new CanonicalMemoryError(
        artifact.relPath,
        'canonical-read-error',
        `${artifact.label} at ${artifact.relPath} has unterminated frontmatter`,
      );
    }
    const fm = raw.slice(4, close);
    try {
      yaml.load(fm, { schema: yaml.FAILSAFE_SCHEMA, json: false });
    } catch (err) {
      throw new CanonicalMemoryError(
        artifact.relPath,
        'canonical-read-error',
        `${artifact.label} at ${artifact.relPath}: YAML frontmatter parse error: ${(err as Error).message}`,
      );
    }
  }
}

async function verifySqliteArtifact(
  absPath: string,
  artifact: MemoryArtifact,
): Promise<void> {
  let fh: Awaited<ReturnType<typeof fs.open>>;
  try {
    fh = await fs.open(absPath, 'r');
  } catch (err) {
    throw new CanonicalMemoryError(
      artifact.relPath,
      'canonical-read-error',
      `cannot open ${artifact.label} at ${artifact.relPath}: ${(err as Error).message}`,
    );
  }
  try {
    const buf = Buffer.alloc(SQLITE_MAGIC.length);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead < buf.length || buf.toString('binary') !== SQLITE_MAGIC) {
      throw new CanonicalMemoryError(
        artifact.relPath,
        'canonical-read-error',
        `${artifact.label} at ${artifact.relPath} is not a valid SQLite file (magic bytes mismatch)`,
      );
    }
  } finally {
    await fh.close();
  }
}

async function verifyArtifact(
  projectRoot: string,
  artifact: MemoryArtifact,
): Promise<ParityMismatch | null> {
  const abs = path.join(projectRoot, artifact.relPath);
  const exists = await pathExists(abs);
  if (!exists) {
    if (!artifact.required) return null;
    return {
      primitive: 'memory',
      instanceName: artifact.relPath,
      framework: 'canonical',
      reasonCode: 'canonical-read-error',
      detail: `${artifact.label} at ${artifact.relPath} is missing — required artifact for the Memory primitive`,
    };
  }
  try {
    if (artifact.kind === 'markdown') {
      await verifyMarkdownArtifact(abs, artifact);
    } else {
      await verifySqliteArtifact(abs, artifact);
    }
  } catch (err) {
    if (err instanceof CanonicalMemoryError) {
      return {
        primitive: 'memory',
        instanceName: artifact.relPath,
        framework: 'canonical',
        reasonCode: err.reasonCode,
        detail: err.message,
      };
    }
    throw err;
  }
  return null;
}

/**
 * The Memory primitive has a fixed canonical artifact set, not user-named
 * instances like Skill/Hook. listInstances() returns the artifact paths so the
 * sentinel can iterate verify() over each, but verify() is also defined to
 * accept any artifact path and return ok:true if it's not in the known set
 * (defensive: sentinel might call with stale names after a config change).
 */
export const memoryParityRule: ParityRule = {
  primitive: 'memory',
  // Memory is framework-agnostic — the verifier ignores framework, but we
  // declare both so the sentinel includes Memory in every framework's matrix
  // cell and surfaces drift consistently.
  frameworks: ['claude-code', 'codex-cli'] as IntelligenceFramework[],
  remediationPolicy: 'flag-only',

  async verify(projectRoot: string, instanceName: string): Promise<VerifyResult> {
    const artifact = ARTIFACTS.find((a) => a.relPath === instanceName);
    if (!artifact) {
      return { ok: true, mismatches: [] };
    }
    const mismatch = await verifyArtifact(projectRoot, artifact);
    return mismatch
      ? { ok: false, mismatches: [mismatch] }
      : { ok: true, mismatches: [] };
  },

  async listInstances(_projectRoot: string): Promise<string[]> {
    return ARTIFACTS.map((a) => a.relPath);
  },

  async remediate(
    _projectRoot: string,
    instanceName: string,
    _framework: IntelligenceFramework,
  ): Promise<void> {
    const artifact = ARTIFACTS.find((a) => a.relPath === instanceName);
    const label = artifact?.label ?? instanceName;
    throw new Error(
      `memory primitive: refused to remediate ${instanceName} (${label}) — ` +
        `Memory artifacts are user/agent-authored and never auto-regenerated. ` +
        `Repair procedure: AGENT.md/USER.md → re-init via \`instar init\`; ` +
        `MEMORY.md → restore from git history or backup; ` +
        `topic-memory.sqlite → restore from backup. ` +
        `See specs/instar-concepts/memory.md for full procedure.`,
    );
  },

  async listOrphans(_projectRoot: string): Promise<ParityMismatch[]> {
    // No rendering callsites in v0.1; no orphans possible.
    return [];
  },

  async removeOrphans(
    _projectRoot: string,
    _framework: IntelligenceFramework,
  ): Promise<string[]> {
    return [];
  },
};
