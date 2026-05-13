import { describe, it, expect } from 'vitest';
import {
  ErrorCodeExtractor,
  type ProbeEmission,
} from '../../src/monitoring/ErrorCodeExtractor.js';

describe('ErrorCodeExtractor — priority ladder', () => {
  it('verified probe emission wins over native code', () => {
    const probe: ProbeEmission = {
      probeId: 'probe-abi',
      errorCode: 'NATIVE_MODULE_ABI_MISMATCH',
      signature: 'sig',
    };
    const err = Object.assign(new Error('boom'), { code: 'ERR_NATIVE_MODULE_ABI_MISMATCH' });
    const result = ErrorCodeExtractor.extract({
      probeEmission: probe,
      nativeError: err,
      verifyProbeSignature: () => true,
    });
    expect(result.code).toBe('NATIVE_MODULE_ABI_MISMATCH');
    expect(result.provenance).toBe('probe-id');
  });

  it('unverified probe emission falls through to lower-priority sources', () => {
    const probe: ProbeEmission = {
      probeId: 'probe-abi',
      errorCode: 'SPOOFED_CODE',
      signature: 'bad',
    };
    const err = Object.assign(new Error('boom'), { code: 'EACCES' });
    const result = ErrorCodeExtractor.extract({
      probeEmission: probe,
      nativeError: err,
      verifyProbeSignature: () => false,
    });
    expect(result.code).toBe('EACCES');
    expect(result.provenance).toBe('native-binding');
  });

  it('subsystem-explicit wins over native code', () => {
    const err = Object.assign(new Error('boom'), { code: 'EACCES' });
    const result = ErrorCodeExtractor.extract({
      subsystemExplicit: 'TOPIC_MEMORY_REINDEX_FAILED',
      nativeError: err,
    });
    expect(result.code).toBe('TOPIC_MEMORY_REINDEX_FAILED');
    expect(result.provenance).toBe('subsystem-explicit');
  });

  it('subsystem-explicit wins over free-text', () => {
    const result = ErrorCodeExtractor.extract({
      subsystemExplicit: 'CUSTOM_CODE',
      freeText: 'NODE_MODULE_VERSION 127 something',
    });
    expect(result.code).toBe('CUSTOM_CODE');
    expect(result.provenance).toBe('subsystem-explicit');
  });
});

describe('ErrorCodeExtractor — native binding', () => {
  it('extracts .code from a native Error', () => {
    const err = Object.assign(new Error('open failed'), {
      code: 'ERR_NATIVE_MODULE_ABI_MISMATCH',
    });
    const result = ErrorCodeExtractor.extract({ nativeError: err });
    expect(result.code).toBe('ERR_NATIVE_MODULE_ABI_MISMATCH');
    expect(result.provenance).toBe('native-binding');
  });

  it('extracts .code from a plain object with code field', () => {
    const result = ErrorCodeExtractor.extract({
      nativeError: { code: 'EACCES', message: 'permission denied' },
    });
    expect(result.code).toBe('EACCES');
    expect(result.provenance).toBe('native-binding');
  });

  it('falls through to free-text when nativeError has no string .code', () => {
    const err = Object.assign(new Error('boom'), { code: 123 as unknown });
    const result = ErrorCodeExtractor.extract({
      nativeError: err,
      freeText: 'NODE_MODULE_VERSION 127',
    });
    expect(result.code).toBe('NATIVE_MODULE_ABI_MISMATCH');
    expect(result.provenance).toBe('free-text');
  });

  it('falls through to free-text when nativeError is null/undefined', () => {
    const result = ErrorCodeExtractor.extract({
      nativeError: null,
      freeText: 'ECONNREFUSED at peer',
    });
    expect(result.code).toBe('CONNECTION_FAILURE');
    expect(result.provenance).toBe('free-text');
  });
});

describe('ErrorCodeExtractor — free-text patterns', () => {
  it('matches NODE_MODULE_VERSION → NATIVE_MODULE_ABI_MISMATCH', () => {
    const result = ErrorCodeExtractor.extract({
      freeText:
        'Error: The module was compiled against NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 141.',
    });
    expect(result.code).toBe('NATIVE_MODULE_ABI_MISMATCH');
    expect(result.provenance).toBe('free-text');
  });

  it('matches SQLITE_CORRUPT → SQLITE_CORRUPT', () => {
    const result = ErrorCodeExtractor.extract({
      freeText: 'SQLITE_CORRUPT: database disk image is malformed',
    });
    expect(result.code).toBe('SQLITE_CORRUPT');
    expect(result.provenance).toBe('free-text');
  });

  it('matches SQLITE_BUSY → SQLITE_BUSY', () => {
    const result = ErrorCodeExtractor.extract({
      freeText: 'SQLITE_BUSY: database is locked',
    });
    expect(result.code).toBe('SQLITE_BUSY');
    expect(result.provenance).toBe('free-text');
  });

  it('matches EACCES → PERMISSION_DENIED', () => {
    const result = ErrorCodeExtractor.extract({
      freeText: 'EACCES: permission denied, open /etc/shadow',
    });
    expect(result.code).toBe('PERMISSION_DENIED');
    expect(result.provenance).toBe('free-text');
  });

  it('matches EPERM → PERMISSION_DENIED', () => {
    const result = ErrorCodeExtractor.extract({
      freeText: 'EPERM: operation not permitted',
    });
    expect(result.code).toBe('PERMISSION_DENIED');
    expect(result.provenance).toBe('free-text');
  });

  it('matches ECONNREFUSED → CONNECTION_FAILURE', () => {
    const result = ErrorCodeExtractor.extract({
      freeText: 'connect ECONNREFUSED 127.0.0.1:4042',
    });
    expect(result.code).toBe('CONNECTION_FAILURE');
    expect(result.provenance).toBe('free-text');
  });

  it('matches ECONNRESET → CONNECTION_FAILURE', () => {
    const result = ErrorCodeExtractor.extract({
      freeText: 'socket hang up ECONNRESET',
    });
    expect(result.code).toBe('CONNECTION_FAILURE');
    expect(result.provenance).toBe('free-text');
  });

  it('returns UNKNOWN_ERROR for unrecognized free-text', () => {
    const result = ErrorCodeExtractor.extract({
      freeText: 'something completely novel happened in module X',
    });
    expect(result.code).toBe('UNKNOWN_ERROR');
    expect(result.provenance).toBe('free-text');
  });

  it('returns UNKNOWN_ERROR with no inputs at all', () => {
    const result = ErrorCodeExtractor.extract({});
    expect(result.code).toBe('UNKNOWN_ERROR');
    expect(result.provenance).toBe('free-text');
  });
});

describe('ErrorCodeExtractor — isAllowedForRunbookMatch', () => {
  it('rejects free-text provenance', () => {
    expect(
      ErrorCodeExtractor.isAllowedForRunbookMatch({
        code: 'NATIVE_MODULE_ABI_MISMATCH',
        provenance: 'free-text',
      }),
    ).toBe(false);
  });

  it('accepts native-binding provenance', () => {
    expect(
      ErrorCodeExtractor.isAllowedForRunbookMatch({
        code: 'EACCES',
        provenance: 'native-binding',
      }),
    ).toBe(true);
  });

  it('accepts probe-id provenance', () => {
    expect(
      ErrorCodeExtractor.isAllowedForRunbookMatch({
        code: 'NATIVE_MODULE_ABI_MISMATCH',
        provenance: 'probe-id',
      }),
    ).toBe(true);
  });

  it('accepts subsystem-explicit provenance', () => {
    expect(
      ErrorCodeExtractor.isAllowedForRunbookMatch({
        code: 'TOPIC_MEMORY_REINDEX_FAILED',
        provenance: 'subsystem-explicit',
      }),
    ).toBe(true);
  });
});
