/**
 * Mesh signing-key resolution (Multi-Machine Session Pool §L0 — the bug that broke
 * the SEND side of every normally-created machine).
 *
 * The server-boot loader for `localSigningKeyPem` (the private key the MeshRpcClient
 * signs every outbound m2m command with) hard-coded the filename `signing-private.pem`.
 * But `MachineIdentity` writes the key as `signing-key.pem` (its `SIGNING_KEY_FILE`),
 * so every normally-created install had `signing-private.pem` ABSENT → `localSigningKeyPem`
 * stayed '' → the MeshRpcClient signed with an empty key → the send threw → the machine
 * could not PULL presence from / TRANSFER to any peer (while still RECEIVING fine, since
 * receive verifies the OTHER machine's key). An install propagated with the non-canonical
 * `signing-private.pem` worked only by accident. Found on real hardware: the laptop (canonical
 * `signing-key.pem`) never recorded the mini until given the legacy filename.
 *
 * These tests pin that the loader prefers the canonical `signing-key.pem` and falls back to
 * the legacy `signing-private.pem`, so BOTH layouts load a key.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('server-boot wiring: mesh signing-key resolution (§L0)', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');

  it('the localSigningKeyPem loader reads the CANONICAL signing-key.pem (not only signing-private.pem)', () => {
    const idx = src.indexOf('let localSigningKeyPem');
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 1200);
    expect(block).toContain("'signing-key.pem'");
  });

  it('tries the canonical name BEFORE the legacy/propagated signing-private.pem (fallback order)', () => {
    const idx = src.indexOf('let localSigningKeyPem');
    const block = src.slice(idx, idx + 1200);
    const canonicalAt = block.indexOf("'signing-key.pem'");
    const legacyAt = block.indexOf("'signing-private.pem'");
    expect(canonicalAt).toBeGreaterThan(0);
    expect(legacyAt).toBeGreaterThan(0);
    expect(canonicalAt).toBeLessThan(legacyAt); // canonical first, legacy fallback
  });

  it('the canonical filename matches MachineIdentity.SIGNING_KEY_FILE', () => {
    const mi = fs.readFileSync(path.join(process.cwd(), 'src/core/MachineIdentity.ts'), 'utf-8');
    expect(mi).toContain("SIGNING_KEY_FILE = 'signing-key.pem'");
  });
});
