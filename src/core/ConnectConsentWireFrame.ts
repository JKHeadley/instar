const MAX_TRANSCRIPT_BYTES = 2048;
const MAX_SIGNATURE_BYTES = 72;

/** Octet framing only. The role-specific verifier must authenticate the returned slices before use. */
export function readConnectConsentFrame(frame: Buffer): { transcript: Buffer; signature: Buffer } | undefined {
  if (frame.length < 6) return;
  const length = frame.readUInt32BE(0);
  if (length === 0 || length > MAX_TRANSCRIPT_BYTES || frame.length < 6 + length) return;
  const offset = 4 + length;
  const signatureLength = frame.readUInt16BE(offset);
  if (signatureLength < 8 || signatureLength > MAX_SIGNATURE_BYTES || frame.length !== offset + 2 + signatureLength) return;
  return { transcript: frame.subarray(4, offset), signature: frame.subarray(offset + 2) };
}
