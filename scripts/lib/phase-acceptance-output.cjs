'use strict';

function describe(value) {
  return JSON.stringify(value);
}

function evaluateJsonExpectation(expectation, stdout, stderr) {
  if (!expectation || typeof expectation !== 'object' || Array.isArray(expectation)) {
    return { ok: false, reason: 'expectJson must be an object' };
  }

  const sourceName = expectation.source ?? 'stdout';
  if (sourceName !== 'stdout' && sourceName !== 'stderr') {
    return { ok: false, reason: 'expectJson.source must be "stdout" or "stderr"' };
  }

  if (typeof expectation.schema !== 'string' || expectation.schema.length === 0) {
    return { ok: false, reason: 'expectJson.schema must be a non-empty string' };
  }

  const expectedFields = expectation.equals;
  if (!expectedFields || typeof expectedFields !== 'object' || Array.isArray(expectedFields)) {
    return { ok: false, reason: 'expectJson.equals must be an object' };
  }

  const raw = (sourceName === 'stdout' ? stdout : stderr).trim();
  let observed;
  try {
    observed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      reason: `expected ${sourceName} to be one JSON document: ${error.message}`,
    };
  }

  if (!observed || typeof observed !== 'object' || Array.isArray(observed)) {
    return { ok: false, reason: `expected ${sourceName} JSON root to be an object` };
  }

  if (observed.schema !== expectation.schema) {
    return {
      ok: false,
      reason: `expected JSON schema ${describe(expectation.schema)}, got ${describe(observed.schema)}`,
    };
  }

  for (const [field, expected] of Object.entries(expectedFields)) {
    if (!Object.prototype.hasOwnProperty.call(observed, field)) {
      return { ok: false, reason: `expected JSON field ${describe(field)} is missing` };
    }
    if (!Object.is(observed[field], expected)) {
      return {
        ok: false,
        reason: `expected JSON field ${describe(field)} to equal ${describe(expected)}, got ${describe(observed[field])}`,
      };
    }
  }

  return { ok: true, reason: '' };
}

function evaluateOutputExpectation(gate, stdout, stderr) {
  if (gate.expectJson) {
    const result = evaluateJsonExpectation(gate.expectJson, stdout, stderr);
    if (!result.ok) return result;
  }

  if (
    gate.expectStdoutContains
    && !stdout.includes(gate.expectStdoutContains)
    && !stderr.includes(gate.expectStdoutContains)
  ) {
    return {
      ok: false,
      reason: `expected stdout to contain "${gate.expectStdoutContains}"`,
    };
  }

  return { ok: true, reason: '' };
}

module.exports = {
  evaluateJsonExpectation,
  evaluateOutputExpectation,
};
