/** Commands carrying one-use credentials must never enter the durable queue. */
export function isEphemeralCredentialCommand(text: string): boolean {
  return /^\/desktop(?:\s|$)/i.test(text.trim());
}
