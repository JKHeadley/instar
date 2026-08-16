/*! scure-base - MIT License (c) 2022 Paul Miller (paulmillr.com) */
/** Transforms values between two representations. */
export interface Coder<F, T> {
    /**
     * Converts a value from the input representation to the output representation.
     * @param from - Value in the source representation.
     * @returns Converted value.
     */
    encode(from: F): T;
    /**
     * Converts a value from the output representation back to the input representation.
     * @param to - Value in the target representation.
     * @returns Converted value.
     */
    decode(to: T): F;
}
/** Coder that works with byte arrays and strings. */
export interface BytesCoder extends Coder<Uint8Array, string> {
    /**
     * Encodes bytes into a string representation.
     * @param data - Bytes to encode.
     * @returns Encoded string.
     */
    encode: (data: Uint8Array) => string;
    /**
     * Decodes a string representation into raw bytes.
     * @param str - Encoded string.
     * @returns Decoded bytes.
     */
    decode: (str: string) => Uint8Array;
}
/**
 * Bytes API type helpers for old + new TypeScript.
 *
 * TS 5.6 has `Uint8Array`, while TS 5.9+ made it generic `Uint8Array<ArrayBuffer>`.
 * We can't use specific return type, because TS 5.6 will error.
 * We can't use generic return type, because most TS 5.9 software will expect specific type.
 *
 * Maps typed-array input leaves to broad forms.
 * These are compatibility adapters, not ownership guarantees.
 *
 * - `TArg` keeps byte inputs broad.
 * - `TRet` marks byte outputs for TS 5.6 and TS 5.9+ compatibility.
 */
export type TypedArg<T> = T extends BigInt64Array ? BigInt64Array : T extends BigUint64Array ? BigUint64Array : T extends Float32Array ? Float32Array : T extends Float64Array ? Float64Array : T extends Int16Array ? Int16Array : T extends Int32Array ? Int32Array : T extends Int8Array ? Int8Array : T extends Uint16Array ? Uint16Array : T extends Uint32Array ? Uint32Array : T extends Uint8ClampedArray ? Uint8ClampedArray : T extends Uint8Array ? Uint8Array : never;
/** Maps typed-array output leaves to narrow TS-compatible forms. */
export type TypedRet<T> = T extends BigInt64Array ? ReturnType<typeof BigInt64Array.of> : T extends BigUint64Array ? ReturnType<typeof BigUint64Array.of> : T extends Float32Array ? ReturnType<typeof Float32Array.of> : T extends Float64Array ? ReturnType<typeof Float64Array.of> : T extends Int16Array ? ReturnType<typeof Int16Array.of> : T extends Int32Array ? ReturnType<typeof Int32Array.of> : T extends Int8Array ? ReturnType<typeof Int8Array.of> : T extends Uint16Array ? ReturnType<typeof Uint16Array.of> : T extends Uint32Array ? ReturnType<typeof Uint32Array.of> : T extends Uint8ClampedArray ? ReturnType<typeof Uint8ClampedArray.of> : T extends Uint8Array ? ReturnType<typeof Uint8Array.of> : never;
/** Recursively adapts byte-carrying API input types. See {@link TypedArg}. */
export type TArg<T> = T | ([TypedArg<T>] extends [never] ? T extends (...args: infer A) => infer R ? ((...args: {
    [K in keyof A]: TRet<A[K]>;
}) => TArg<R>) & {
    [K in keyof T]: T[K] extends (...args: any) => any ? T[K] : TArg<T[K]>;
} : T extends [infer A, ...infer R] ? [TArg<A>, ...{
    [K in keyof R]: TArg<R[K]>;
}] : T extends readonly [infer A, ...infer R] ? readonly [TArg<A>, ...{
    [K in keyof R]: TArg<R[K]>;
}] : T extends (infer A)[] ? TArg<A>[] : T extends readonly (infer A)[] ? readonly TArg<A>[] : T extends Promise<infer A> ? Promise<TArg<A>> : T extends object ? {
    [K in keyof T]: TArg<T[K]>;
} : T : TypedArg<T>);
/** Recursively adapts byte-carrying API output types. See {@link TypedArg}. */
export type TRet<T> = T extends unknown ? T & ([TypedRet<T>] extends [never] ? T extends (...args: infer A) => infer R ? ((...args: {
    [K in keyof A]: TArg<A[K]>;
}) => TRet<R>) & {
    [K in keyof T]: T[K] extends (...args: any) => any ? T[K] : TRet<T[K]>;
} : T extends [infer A, ...infer R] ? [TRet<A>, ...{
    [K in keyof R]: TRet<R[K]>;
}] : T extends readonly [infer A, ...infer R] ? readonly [TRet<A>, ...{
    [K in keyof R]: TRet<R[K]>;
}] : T extends (infer A)[] ? TRet<A>[] : T extends readonly (infer A)[] ? readonly TRet<A>[] : T extends Promise<infer A> ? Promise<TRet<A>> : T extends object ? {
    [K in keyof T]: TRet<T[K]>;
} : T : TypedRet<T>) : never;
type Chain = [Coder<any, any>, ...Coder<any, any>[]];
type Input<F> = F extends Coder<infer T, any> ? T : never;
type Output<F> = F extends Coder<any, infer T> ? T : never;
type First<T> = T extends [infer U, ...any[]] ? U : never;
type Last<T> = T extends [...any[], infer U] ? U : never;
type Tail<T> = T extends [any, ...infer U] ? U : never;
type AsChain<C extends Chain, Rest = Tail<C>> = {
    [K in keyof C]: Coder<Input<C[K]>, Input<K extends keyof Rest ? Rest[K] : any>>;
};
/**
 * @__NO_SIDE_EFFECTS__
 */
declare function chain<T extends Chain & AsChain<T>>(...args: T): Coder<Input<First<T>>, Output<Last<T>>>;
/**
 * Encodes integer radix representation to array of strings using alphabet and back.
 * Could also be array of strings.
 * @__NO_SIDE_EFFECTS__
 */
declare function alphabet(letters: string | string[]): Coder<number[], string[]>;
/**
 * @__NO_SIDE_EFFECTS__
 */
declare function join(separator?: string): Coder<string[], string>;
/**
 * Pad strings array so it has integer number of bits
 * @__NO_SIDE_EFFECTS__
 */
declare function padding(bits: number, chr?: string): Coder<string[], string[]>;
/**
 * Slow: O(n^2) time complexity
 */
declare function convertRadix(data: number[], from: number, to: number): number[];
/**
 * Implemented with numbers, because BigInt is 5x slower
 */
declare function convertRadix2(data: number[], from: number, to: number, padding: boolean): number[];
/**
 * @__NO_SIDE_EFFECTS__
 */
declare function radix(num: number): TRet<Coder<Uint8Array, number[]>>;
/**
 * If both bases are power of same number (like `2**8 <-> 2**64`),
 * there is a linear algorithm. For now we have implementation for power-of-two bases only.
 * @__NO_SIDE_EFFECTS__
 */
declare function radix2(bits: number, revPadding?: boolean): TRet<Coder<Uint8Array, number[]>>;
type BytesFn = (data: TArg<Uint8Array>) => TRet<Uint8Array>;
declare function checksum(len: number, fn: TArg<BytesFn>): TRet<Coder<Uint8Array, Uint8Array>>;
/**
 * Low-level building blocks used by the exported codecs.
 * @example
 * Build a radix-32 coder from the low-level helpers.
 * ```ts
 * import { utils } from '@scure/base';
 * utils.radix2(5).encode(Uint8Array.from([1, 2, 3]));
 * ```
 */
export declare const utils: {
    alphabet: typeof alphabet;
    chain: typeof chain;
    checksum: typeof checksum;
    convertRadix: typeof convertRadix;
    convertRadix2: typeof convertRadix2;
    radix: typeof radix;
    radix2: typeof radix2;
    join: typeof join;
    padding: typeof padding;
};
/**
 * base16 encoding from RFC 4648.
 * This codec uses RFC 4648 Table 5's uppercase alphabet directly.
 * RFC 4648 §8 calls base16 "case-insensitive hex encoding", but we intentionally do not case-fold decode input here.
 * Use `hex` for case-insensitive hex decoding.
 * @example
 * ```js
 * base16.encode(Uint8Array.from([0x12, 0xab]));
 * // => '12AB'
 * ```
 */
export declare const base16: BytesCoder;
/**
 * base32 encoding from RFC 4648. Has padding.
 * RFC 4648 §6 Table 3 uses uppercase letters, and RFC 4648 §3.4 allows applications to choose
 * upper- or lowercase alphabets. We keep the published uppercase table and do not case-fold decode input.
 * Use `base32nopad` for unpadded version.
 * Also check out `base32hex`, `base32hexnopad`, `base32crockford`.
 * @example
 * ```js
 * base32.encode(Uint8Array.from([0x12, 0xab]));
 * // => 'CKVQ===='
 * base32.decode('CKVQ====');
 * // => Uint8Array.from([0x12, 0xab])
 * ```
 */
export declare const base32: BytesCoder;
/**
 * base32 encoding from RFC 4648. No padding.
 * This variant inherits RFC 4648 base32's uppercase table and intentionally does not case-fold decode input.
 * Use `base32` for padded version.
 * Also check out `base32hex`, `base32hexnopad`, `base32crockford`.
 * @example
 * ```js
 * base32nopad.encode(Uint8Array.from([0x12, 0xab]));
 * // => 'CKVQ'
 * base32nopad.decode('CKVQ');
 * // => Uint8Array.from([0x12, 0xab])
 * ```
 */
export declare const base32nopad: BytesCoder;
/**
 * base32 encoding from RFC 4648. Padded. Compared to ordinary `base32`, slightly different alphabet.
 * RFC 4648 §7 Table 4 uses uppercase letters, and we intentionally keep that table without case-folding decode input.
 * Use `base32hexnopad` for unpadded version.
 * @example
 * ```js
 * base32hex.encode(Uint8Array.from([0x12, 0xab]));
 * // => '2ALG===='
 * base32hex.decode('2ALG====');
 * // => Uint8Array.from([0x12, 0xab])
 * ```
 */
export declare const base32hex: BytesCoder;
/**
 * base32 encoding from RFC 4648. No padding. Compared to ordinary `base32`, slightly different alphabet.
 * This variant inherits RFC 4648 base32hex's uppercase table and intentionally does not case-fold decode input.
 * Use `base32hex` for padded version.
 * @example
 * ```js
 * base32hexnopad.encode(Uint8Array.from([0x12, 0xab]));
 * // => '2ALG'
 * base32hexnopad.decode('2ALG');
 * // => Uint8Array.from([0x12, 0xab])
 * ```
 */
export declare const base32hexnopad: BytesCoder;
/**
 * base32 encoding from RFC 4648. Doug Crockford's version.
 * See {@link https://www.crockford.com/base32.html | Douglas Crockford's Base32}.
 * @example
 * ```js
 * base32crockford.encode(Uint8Array.from([0x12, 0xab]));
 * // => '2ANG'
 * base32crockford.decode('2ANG');
 * // => Uint8Array.from([0x12, 0xab])
 * ```
 */
export declare const base32crockford: BytesCoder;
/**
 * base64 from RFC 4648. Padded.
 * Use `base64nopad` for unpadded version.
 * Also check out `base64url`, `base64urlnopad`.
 * Falls back to built-in function, when available.
 * @example
 * ```js
 * base64.encode(Uint8Array.from([0x12, 0xab]));
 * // => 'Eqs='
 * base64.decode('Eqs=');
 * // => Uint8Array.from([0x12, 0xab])
 * ```
 */
export declare const base64: BytesCoder;
/**
 * base64 from RFC 4648. No padding.
 * Use `base64` for padded version.
 * @example
 * ```js
 * base64nopad.encode(Uint8Array.from([0x12, 0xab]));
 * // => 'Eqs'
 * base64nopad.decode('Eqs');
 * // => Uint8Array.from([0x12, 0xab])
 * ```
 */
export declare const base64nopad: BytesCoder;
/**
 * base64 from RFC 4648, using URL-safe alphabet. Padded.
 * Use `base64urlnopad` for unpadded version.
 * Falls back to built-in function, when available.
 * @example
 * ```js
 * base64url.encode(Uint8Array.from([0x12, 0xab]));
 * // => 'Eqs='
 * base64url.decode('Eqs=');
 * // => Uint8Array.from([0x12, 0xab])
 * ```
 */
export declare const base64url: BytesCoder;
/**
 * base64 from RFC 4648, using URL-safe alphabet. No padding.
 * Use `base64url` for padded version.
 * @example
 * ```js
 * base64urlnopad.encode(Uint8Array.from([0x12, 0xab]));
 * // => 'Eqs'
 * base64urlnopad.decode('Eqs');
 * // => Uint8Array.from([0x12, 0xab])
 * ```
 */
export declare const base64urlnopad: BytesCoder;
/**
 * base58: base64 without ambigous characters +, /, 0, O, I, l.
 * Quadratic (O(n^2)) - so, can't be used on large inputs.
 * @example
 * ```js
 * const text = base58.encode(Uint8Array.from([0, 1, 2]));
 * base58.decode(text);
 * // => Uint8Array.from([0, 1, 2])
 * ```
 */
export declare const base58: BytesCoder;
/**
 * base58: flickr version. Check out `base58`.
 * @example
 * Round-trip bytes with the Flickr alphabet.
 * ```ts
 * const text = base58flickr.encode(Uint8Array.from([0, 1, 2]));
 * base58flickr.decode(text);
 * ```
 */
export declare const base58flickr: BytesCoder;
/**
 * base58: XRP version. Check out `base58`.
 * @example
 * Round-trip bytes with the XRP alphabet.
 * ```ts
 * const text = base58xrp.encode(Uint8Array.from([0, 1, 2]));
 * base58xrp.decode(text);
 * ```
 */
export declare const base58xrp: BytesCoder;
/**
 * base58: XMR version. Check out `base58`.
 * Done in 8-byte blocks (which equals 11 chars in decoding). Last (non-full) block padded with '1' to size in XMR_BLOCK_LEN.
 * Block encoding significantly reduces quadratic complexity of base58.
 * @example
 * Round-trip bytes with the Monero block codec.
 * ```ts
 * const text = base58xmr.encode(Uint8Array.from([0, 1, 2]));
 * base58xmr.decode(text);
 * ```
 */
export declare const base58xmr: BytesCoder;
/**
 * Method, which creates base58check encoder.
 * Requires function, calculating sha256.
 * Callers must include any version bytes in `data`; this helper only applies the
 * 4-byte double-SHA256 checksum used by Bitcoin Base58Check.
 * @param sha256 - Function used to calculate the checksum hash.
 * @returns base58check codec using 4 checksum bytes.
 * @throws On wrong argument types. {@link TypeError}
 * @example
 * Create a base58check codec from a SHA-256 implementation.
 * ```ts
 * import { createBase58check } from '@scure/base';
 * import { sha256 } from '@noble/hashes/sha2.js';
 * const coder = createBase58check(sha256);
 * coder.encode(Uint8Array.from([1, 2, 3]));
 * ```
 */
export declare const createBase58check: (sha256: TArg<BytesFn>) => BytesCoder;
/**
 * Use `createBase58check` instead.
 * @deprecated Use {@link createBase58check} instead.
 * Callers must include any version bytes in `data`; this alias keeps the same
 * 4-byte double-SHA256 checksum behavior as `createBase58check`.
 * @param sha256 - Function used to calculate the checksum hash.
 * @returns base58check codec using 4 checksum bytes.
 * @example
 * Create a base58check codec with the deprecated alias.
 * ```ts
 * import { base58check } from '@scure/base';
 * import { sha256 } from '@noble/hashes/sha2.js';
 * const coder = base58check(sha256);
 * coder.encode(Uint8Array.from([1, 2, 3]));
 * ```
 */
export declare const base58check: (sha256: TArg<BytesFn>) => BytesCoder;
/** Result of bech32 decoding. */
export interface Bech32Decoded<Prefix extends string = string> {
    /** Human-readable bech32 prefix. */
    prefix: Prefix;
    /** Decoded 5-bit word payload. */
    words: number[];
}
/** Result of bech32 decoding with original bytes attached. */
export interface Bech32DecodedWithArray<Prefix extends string = string> {
    /** Human-readable bech32 prefix. */
    prefix: Prefix;
    /** Decoded 5-bit word payload. */
    words: number[];
    /** Decoded payload converted back into raw bytes. */
    bytes: Uint8Array;
}
/** bech32 codec surface. */
export interface Bech32 {
    /**
     * Encodes a human-readable prefix and 5-bit words into a bech32 string.
     * @param prefix - Human-readable prefix.
     * @param words - 5-bit words or raw bytes.
     * @param limit - Maximum accepted output length, or `false` to disable the limit.
     * @returns Encoded bech32 string.
     */
    encode<Prefix extends string>(prefix: Prefix, words: number[] | Uint8Array, limit?: number | false): `${Lowercase<Prefix>}1${string}`;
    /**
     * Decodes a bech32 string into prefix and words.
     * @param str - Encoded bech32 string.
     * @param limit - Maximum accepted input length, or `false` to disable the limit.
     * @returns Decoded prefix and 5-bit words.
     */
    decode<Prefix extends string>(str: `${Prefix}1${string}`, limit?: number | false): Bech32Decoded<Prefix>;
    decode(str: string, limit?: number | false): Bech32Decoded;
    /**
     * Encodes raw bytes by first converting them to 5-bit words.
     * @param prefix - Human-readable prefix.
     * @param bytes - Raw bytes to encode.
     * @returns Encoded bech32 string.
     */
    encodeFromBytes(prefix: string, bytes: Uint8Array): string;
    /**
     * Decodes a bech32 string and converts the payload back into bytes.
     * @param str - Encoded bech32 string.
     * @returns Decoded prefix, words, and bytes.
     */
    decodeToBytes(str: string): Bech32DecodedWithArray;
    /**
     * Decodes a bech32 string, returning `undefined` instead of throwing on invalid input.
     * @param str - Encoded bech32 string.
     * @param limit - Maximum accepted input length, or `false` to disable the limit.
     * @returns Decoded prefix and words, or `undefined` for invalid input.
     */
    decodeUnsafe(str: string, limit?: number | false): void | Bech32Decoded<string>;
    /**
     * Converts 5-bit words back into raw bytes.
     * @param to - 5-bit words to decode.
     * @returns Decoded bytes.
     */
    fromWords(to: number[]): Uint8Array;
    /**
     * Converts 5-bit words back into raw bytes, returning `undefined` instead of throwing.
     * @param to - 5-bit words to decode.
     * @returns Decoded bytes, or `undefined` for invalid input.
     */
    fromWordsUnsafe(to: number[]): void | Uint8Array;
    /**
     * Converts raw bytes into 5-bit words for bech32 encoding.
     * @param from - Raw bytes to convert.
     * @returns 5-bit words.
     */
    toWords(from: Uint8Array): number[];
}
/**
 * bech32 from BIP 173. Operates on words.
 * For high-level helpers, check out {@link https://github.com/paulmillr/scure-btc-signer | scure-btc-signer}.
 * @example
 * Convert bytes to words, encode them, then decode back.
 * ```ts
 * const words = bech32.toWords(Uint8Array.from([1, 2, 3]));
 * const text = bech32.encode('bc', words);
 * bech32.decode(text);
 * ```
 */
export declare const bech32: TRet<Bech32>;
/**
 * bech32m from BIP 350. Operates on words.
 * It was to mitigate `bech32` weaknesses.
 * For high-level helpers, check out {@link https://github.com/paulmillr/scure-btc-signer | scure-btc-signer}.
 * @example
 * Convert bytes to words, encode them with bech32m, then decode back.
 * ```ts
 * const words = bech32m.toWords(Uint8Array.from([1, 2, 3]));
 * const text = bech32m.encode('bc', words);
 * bech32m.decode(text);
 * ```
 */
export declare const bech32m: TRet<Bech32>;
/**
 * ASCII-to-byte decoder. Rejects non-ASCII text and bytes instead of doing UTF-8 replacement.
 * Method names follow `BytesCoder`, so `encode(bytes)` returns a string and `decode(string)` returns bytes.
 * @example
 * ```js
 * const b = ascii.decode("ABC"); // => new Uint8Array([ 65, 66, 67 ])
 * const str = ascii.encode(b); // "ABC"
 * ```
 */
export declare const ascii: TRet<BytesCoder>;
/**
 * Strict UTF-8-to-byte decoder. Uses built-in TextDecoder / TextEncoder when available.
 * Method names follow `BytesCoder`, so `encode(bytes)` returns a string and
 * `decode(string)` returns bytes.
 * `encode(bytes)` requires Uint8Array input, preserves an explicit leading BOM, and
 *   throws on invalid UTF-8 bytes.
 * `decode(string)` requires a primitive string and throws on malformed UTF-16 strings with
 *   lone surrogates.
 * @example
 * ```js
 * const b = utf8.decode("hey"); // => new Uint8Array([ 104, 101, 121 ])
 * const str = utf8.encode(b); // "hey"
 * ```
 */
export declare const utf8: BytesCoder;
export declare const __TESTS: {
    utf8Fallback: BytesCoder;
    _isWellFormedShim: (str: string) => boolean;
};
/**
 * hex string decoder. Uses built-in function, when available.
 * Lowercase codec; unlike `base16`, this variant accepts either hex case and emits lowercase.
 * @example
 * ```js
 * const b = hex.decode("0102ff"); // => new Uint8Array([ 1, 2, 255 ])
 * const str = hex.encode(b); // "0102ff"
 * ```
 */
export declare const hex: BytesCoder;
/** Built-in codecs exposed through the deprecated string conversion helpers. */
export type SomeCoders = {
    /** UTF-8 string codec. */
    utf8: BytesCoder;
    /** Hex codec. */
    hex: BytesCoder;
    /** Uppercase RFC 4648 base16 codec. */
    base16: BytesCoder;
    /** RFC 4648 base32 codec with padding. */
    base32: BytesCoder;
    /** RFC 4648 base64 codec with padding. */
    base64: BytesCoder;
    /** URL-safe base64 codec without `+` or `/`. */
    base64url: BytesCoder;
    /** Bitcoin-style base58 codec. */
    base58: BytesCoder;
    /** Monero-style base58 codec. */
    base58xmr: BytesCoder;
};
type CoderType = keyof SomeCoders;
/**
 * Encodes bytes with one of the built-in codecs.
 * @deprecated Use the codec directly, for example `hex.encode(bytes)`.
 * @param type - Codec name.
 * @param bytes - Bytes to encode.
 * @returns Encoded string.
 * @throws On wrong argument types. {@link TypeError}
 * @example
 * ```ts
 * bytesToString('hex', Uint8Array.from([1, 2, 255]));
 * ```
 */
export declare const bytesToString: (type: CoderType, bytes: TArg<Uint8Array>) => string;
/**
 * Alias for `bytesToString`.
 * @deprecated Use {@link bytesToString} or the codec directly instead.
 * @param type - Codec name.
 * @param bytes - Bytes to encode.
 * @returns Encoded string.
 * @example
 * ```ts
 * str('hex', Uint8Array.from([1, 2, 255]));
 * ```
 */
export declare const str: (type: CoderType, bytes: TArg<Uint8Array>) => string;
/**
 * Decodes a string with one of the built-in codecs.
 * @deprecated Use the codec directly, for example `hex.decode(text)`.
 * @param type - Codec name.
 * @param str - Encoded string.
 * @returns Decoded bytes.
 * @throws On wrong argument types. {@link TypeError}
 * @example
 * ```ts
 * stringToBytes('hex', '0102ff');
 * ```
 */
export declare const stringToBytes: (type: CoderType, str: string) => TRet<Uint8Array>;
/**
 * Alias for `stringToBytes`.
 * @deprecated Use {@link stringToBytes} or the codec directly instead.
 * @param type - Codec name.
 * @param str - Encoded string.
 * @returns Decoded bytes.
 * @example
 * ```ts
 * bytes('hex', '0102ff');
 * ```
 */
export declare const bytes: (type: CoderType, str: string) => TRet<Uint8Array>;
export {};
//# sourceMappingURL=index.d.ts.map