export function runTimeMs(v: unknown): number;
export function latestPerName<T>(
  rows: readonly T[] | unknown,
  acc: { name: (r: T) => string; workflow?: (r: T) => string; order: (r: T) => number; open: (r: T) => boolean },
): T[];
