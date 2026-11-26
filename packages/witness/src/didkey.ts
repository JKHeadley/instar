/**
 * did:key for Ed25519 keys (W3C did:key method): `did:key:z` + base58btc of the
 * multicodec ed25519-pub prefix (0xed 0x01) followed by the 32-byte public key.
 *
 * A did:key issuer in a Witness record names the agent's THREADLINE identity key,
 * never its Witness key: the binding is what reaches the Witness key, so naming the
 * Witness key would make the binding self-referential and change the issuer's name
 * at every Witness-key rotation. Naming the Threadline key also lets an offline
 * verifier check that a binding really belongs to the issuer.
 *
 * Native code only, no dependencies, like the rest of the package.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ED25519_PUB_PREFIX = [0xed, 0x01];

function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join('');
}

function base58Decode(text: string): Uint8Array | null {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i++) {
    let carry = ALPHABET.indexOf(text[i]);
    if (carry < 0) return null;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

/** The did:key for a raw 32-byte Ed25519 public key given as hex. */
export function didKeyFromPublicKey(publicKeyHex: string): string {
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) throw new TypeError('publicKey must be 32 bytes of hex');
  const bytes = Uint8Array.from([...ED25519_PUB_PREFIX, ...Buffer.from(publicKeyHex, 'hex')]);
  return `did:key:z${base58Encode(bytes)}`;
}

/** The Ed25519 public key (hex) a did:key names, or null if it is not an Ed25519 did:key. */
export function publicKeyFromDidKey(did: string): string | null {
  const m = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)$/.exec(did);
  if (!m) return null;
  const bytes = base58Decode(m[1]);
  if (!bytes || bytes.length !== 34 || bytes[0] !== ED25519_PUB_PREFIX[0] || bytes[1] !== ED25519_PUB_PREFIX[1]) return null;
  return Buffer.from(bytes.subarray(2)).toString('hex');
}
