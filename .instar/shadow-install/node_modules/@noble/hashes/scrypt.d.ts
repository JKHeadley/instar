import { type KDFInput, type TArg, type TRet } from './utils.ts';
/**
 * Scrypt options:
 * - `N` is cpu/mem work factor (power of 2 e.g. `2**18`)
 * - `r` is block size (8 is common), fine-tunes sequential memory read size and performance
 * - `p` is parallelization factor (1 is common)
 * - `dkLen` is output key length in bytes e.g. 32, and must be `>= 1` per RFC 7914 §2.
 * - `asyncTick` - (default: 10) max time in ms for which async function can block execution
 * - `maxmem` - (default: `1024 ** 3 + 1024` aka 1GB+1KB). A limit that the app could use for scrypt
 * - `onProgress` - callback function that would be executed for progress report
 */
export type ScryptOpts = {
    /** CPU and memory work factor. Must be a power of two. */
    N: number;
    /** Block size parameter. */
    r: number;
    /** Parallelization factor. */
    p: number;
    /** Desired derived key length in bytes, must be `>= 1` per RFC 7914 §2. */
    dkLen?: number;
    /** Max scheduler block time in milliseconds for the async variant. */
    asyncTick?: number;
    /** Maximum temporary memory budget in bytes. */
    maxmem?: number;
    /**
     * Optional progress callback invoked during long-running derivations.
     * param progress - completion fraction in the `0..1` range
     */
    onProgress?: (progress: number) => void;
};
/**
 * Scrypt KDF from RFC 7914. See {@link ScryptOpts}.
 * @param password - password or key material to derive from;
 *   JS string inputs are UTF-8 encoded first
 * @param salt - unique salt bytes or string; JS string inputs are UTF-8 encoded first
 * @param opts - Scrypt cost and memory parameters. `dkLen`, if provided,
 *   must be `>= 1` per RFC 7914 §2. See {@link ScryptOpts}.
 * @returns Derived key bytes.
 * @throws If the Scrypt cost, memory, or callback options are invalid. {@link Error}
 * @example
 * Derive a key with scrypt.
 * ```ts
 * scrypt('password', 'salt', { N: 2**18, r: 8, p: 1, dkLen: 32 });
 * ```
 */
export declare function scrypt(password: TArg<KDFInput>, salt: TArg<KDFInput>, opts: TArg<ScryptOpts>): TRet<Uint8Array>;
/**
 * Scrypt KDF from RFC 7914. Async version. See {@link ScryptOpts}.
 * @param password - password or key material to derive from;
 *   JS string inputs are UTF-8 encoded first
 * @param salt - unique salt bytes or string; JS string inputs are UTF-8 encoded first
 * @param opts - Scrypt cost and memory parameters. `dkLen`, if provided,
 *   must be `>= 1` per RFC 7914 §2. `asyncTick` is only a local
 *   scheduler-yield control for this JS wrapper, not part of RFC 7914.
 *   See {@link ScryptOpts}.
 * @returns Promise resolving to derived key bytes.
 * @throws If the Scrypt cost, memory, or callback options are invalid. {@link Error}
 * @example
 * Derive a key with scrypt asynchronously.
 * ```ts
 * await scryptAsync('password', 'salt', { N: 2**18, r: 8, p: 1, dkLen: 32 });
 * ```
 */
export declare function scryptAsync(password: TArg<KDFInput>, salt: TArg<KDFInput>, opts: TArg<ScryptOpts>): Promise<TRet<Uint8Array>>;
//# sourceMappingURL=scrypt.d.ts.map