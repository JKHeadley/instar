/** Evidence stays bounded even if a test writes continuously. */
export const UNIT_OUTPUT_PREFIX_BYTES = 2 * 1024 * 1024;
export const UNIT_OUTPUT_SUFFIX_BYTES = 64 * 1024;

export interface UnitProcessOutput {
  prefix: string;
  suffix: string;
  omittedBytes: number;
}

export class BoundedUnitProcessOutput {
  private readonly prefixParts: Buffer[] = [];
  private prefixBytes = 0;
  private suffix = Buffer.alloc(0);
  private overflowBytes = 0;

  append(chunk: Buffer): void {
    const prefixLength = Math.min(chunk.length, UNIT_OUTPUT_PREFIX_BYTES - this.prefixBytes);
    if (prefixLength > 0) {
      this.prefixParts.push(Buffer.from(chunk.subarray(0, prefixLength)));
      this.prefixBytes += prefixLength;
    }
    const overflow = chunk.subarray(prefixLength);
    if (overflow.length === 0) return;
    this.overflowBytes += overflow.length;
    this.suffix = overflow.length >= UNIT_OUTPUT_SUFFIX_BYTES
      ? Buffer.from(overflow.subarray(-UNIT_OUTPUT_SUFFIX_BYTES))
      : Buffer.concat([this.suffix.subarray(overflow.length - UNIT_OUTPUT_SUFFIX_BYTES), overflow]);
  }

  snapshot(): UnitProcessOutput {
    const omittedBytes = this.overflowBytes - this.suffix.length;
    const prefix = Buffer.concat(this.prefixParts, this.prefixBytes);
    if (omittedBytes === 0) {
      return { prefix: Buffer.concat([prefix, this.suffix]).toString('utf8'), suffix: '', omittedBytes };
    }
    return { prefix: prefix.toString('utf8'), suffix: this.suffix.toString('utf8'), omittedBytes };
  }
}
