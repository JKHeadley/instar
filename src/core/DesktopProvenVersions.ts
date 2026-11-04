/**
 * The macOS versions locked-screen access may run on. A version enters this
 * table only after proof rows P12 (crash) and P15 (Stop) have passed on real
 * hardware, with the evidence named. It ships EMPTY, so no Mac can enable the
 * feature. This is deliberately source, not config: no environment variable,
 * config key or route reaches it. A test harness compiles in its own table.
 * Operator condition, 2026-11-01, topic 134088.
 */
export interface DesktopProvenVersion {
  osMajor: number;
  /** Where the recorded pass lives, for each required gate. */
  p12: string;
  p15: string;
  /** Actions P13 refused on this version, passed to the helper. */
  refuse: string[];
}

export const PROVEN_MACOS_VERSIONS: readonly DesktopProvenVersion[] = Object.freeze([]);

export function provenVersion(table: readonly DesktopProvenVersion[], osMajor: number | undefined): DesktopProvenVersion | null {
  if (!Number.isSafeInteger(osMajor)) return null;
  const row = table.find(item => item.osMajor === osMajor);
  return row && row.p12.trim() && row.p15.trim() ? row : null;
}
