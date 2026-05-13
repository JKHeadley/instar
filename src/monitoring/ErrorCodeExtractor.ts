/**
 * ErrorCodeExtractor — structured errorCode extraction with provenance.
 *
 * Owns the contract that NormalizedDegradationEvent.errorCode carries a
 * provenance tag. Per SELF-HEALING-REMEDIATOR-V2-SPEC.md §A6, runbooks
 * may only match against events whose errorCode came from a structured
 * source ("native-binding", "probe-id", "subsystem-explicit"). Free-text
 * extraction is allowed at the event layer (so events aren't dropped)
 * but the registry-load-time validator REFUSES to register any runbook
 * whose eventPrefilter.errorCode matches free-text-provenance events.
 *
 * Extraction priority (highest first):
 *   1. probeEmission with verified signature → "probe-id"
 *   2. subsystemExplicit                     → "subsystem-explicit"
 *   3. nativeError.code (Node Error.code)    → "native-binding"
 *   4. freeText regex extraction             → "free-text"
 *   5. Fallback                              → "UNKNOWN_ERROR" / "free-text"
 *
 * F-2 foundation module — built before any v2 wrapper PR (W-*) so the
 * provenance contract exists before runbook matchers consume it.
 */

export type ErrorProvenance =
  | 'native-binding'
  | 'probe-id'
  | 'subsystem-explicit'
  | 'free-text';

export interface ExtractedErrorCode {
  /** Canonical errorCode string, e.g. 'NATIVE_MODULE_ABI_MISMATCH'. */
  code: string;
  /** Where the code came from — gates runbook matching. */
  provenance: ErrorProvenance;
}

export interface ProbeEmission {
  probeId: string;
  errorCode: string;
  /** HMAC signature of (probeId|errorCode) — must verify before trust. */
  signature: string;
}

export interface ErrorCodeExtractorInput {
  /** The original Error object, if available. */
  nativeError?: unknown;
  /** Probe-supplied errorCode + signature, if probe-emitted. */
  probeEmission?: ProbeEmission;
  /** Subsystem-supplied explicit errorCode, if caller set one. */
  subsystemExplicit?: string;
  /** Free-form error text for fallback regex extraction. */
  freeText?: string;
  /**
   * Probe signature verifier. Injected so tests don't need real HMAC keys.
   * Returns true if the probe emission is trustworthy. If not provided,
   * probe emissions are treated as unverified and skipped (falling through
   * to lower-priority sources). Per A6, only verified probe emissions are
   * allowed to populate provenance: "probe-id".
   */
  verifyProbeSignature?: (emission: ProbeEmission) => boolean;
}

/**
 * Free-text fallback patterns. Order matters — more specific patterns
 * (NODE_MODULE_VERSION, SQLITE_*) run before generic ones so they win.
 *
 * NOTE: matchers consuming free-text-provenance results are refused at
 * registry load (§A6). These patterns exist for observability and for
 * SystemReviewer clustering (proposing new runbooks), not for matching.
 */
const FREE_TEXT_PATTERNS: Array<{ pattern: RegExp; mapper: (m: RegExpExecArray) => string }> = [
  {
    // Node native module ABI mismatches surface NODE_MODULE_VERSION first.
    pattern: /NODE_MODULE_VERSION\s+\d+/,
    mapper: () => 'NATIVE_MODULE_ABI_MISMATCH',
  },
  {
    // better-sqlite3 / sqlite3 module errors prefix with SQLITE_*.
    pattern: /SQLITE_([A-Z0-9]+)/,
    mapper: (m) => `SQLITE_${m[1]}`,
  },
  {
    pattern: /\b(EACCES|EPERM)\b/,
    mapper: () => 'PERMISSION_DENIED',
  },
  {
    pattern: /\b(ECONNREFUSED|ECONNRESET)\b/,
    mapper: () => 'CONNECTION_FAILURE',
  },
];

function extractFromFreeText(text: string): string {
  for (const { pattern, mapper } of FREE_TEXT_PATTERNS) {
    const m = pattern.exec(text);
    if (m) return mapper(m);
  }
  return 'UNKNOWN_ERROR';
}

/**
 * Read a `.code` property off a thrown value if present and string-typed.
 * Node native modules and several stdlib paths set this (`ERR_*`, `EACCES`,
 * etc.). We trust this field because it comes from a structured property,
 * not parsed text — hence provenance: "native-binding".
 */
function readNativeCode(err: unknown): string | null {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return null;
}

export class ErrorCodeExtractor {
  /**
   * Extract a single ExtractedErrorCode following the priority ladder
   * documented at the top of this file. Always returns a result — never
   * throws — so callers can normalize unconditionally.
   */
  static extract(input: ErrorCodeExtractorInput): ExtractedErrorCode {
    // 1. Verified probe emission wins. Without a verifier, probe emissions
    //    are untrusted (an attacker could shape errorCode by spoofing the
    //    probe path) so we fall through to the next source.
    if (input.probeEmission) {
      const verifier = input.verifyProbeSignature;
      if (verifier && verifier(input.probeEmission)) {
        return {
          code: input.probeEmission.errorCode,
          provenance: 'probe-id',
        };
      }
      // Unverified probe emission — skip and try lower-priority sources.
      // We don't trust the emission, but we also don't reject the whole
      // event; the subsystem may still have supplied a structured code.
    }

    // 2. Subsystem-explicit errorCode — caller set this with no string
    //    extraction, so we trust the structured source.
    if (typeof input.subsystemExplicit === 'string' && input.subsystemExplicit.length > 0) {
      return {
        code: input.subsystemExplicit,
        provenance: 'subsystem-explicit',
      };
    }

    // 3. Native binding: Error.code from Node native modules.
    const nativeCode = readNativeCode(input.nativeError);
    if (nativeCode) {
      return {
        code: nativeCode,
        provenance: 'native-binding',
      };
    }

    // 4. Free-text fallback. Always free-text provenance, even when a
    //    known pattern matches — the input was untrusted parsed text.
    const freeText = typeof input.freeText === 'string' ? input.freeText : '';
    return {
      code: extractFromFreeText(freeText),
      provenance: 'free-text',
    };
  }

  /**
   * Used by the runbook registry validator to refuse runbooks whose
   * `eventPrefilter.errorCode` could match free-text-provenance events
   * (§A6). Free-text matchers create an injection surface — attacker
   * shapes error message → forces unintended runbook to fire — and are
   * structurally forbidden at registry load.
   */
  static isAllowedForRunbookMatch(extracted: ExtractedErrorCode): boolean {
    return (
      extracted.provenance === 'native-binding' ||
      extracted.provenance === 'probe-id' ||
      extracted.provenance === 'subsystem-explicit'
    );
  }
}
