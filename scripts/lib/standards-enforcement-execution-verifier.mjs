import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  createAuthenticatedReceiptAuthority,
  isLiveAuthenticatedObserverEvent,
  isLiveAuthenticatedReceipt,
} from "../../scratchpad/phaseB/authenticated-execution-receipt.mjs";
import { SafeFsExecutor } from "../../dist/core/SafeFsExecutor.js";

const ARTIFACT_SCHEMA = "standards-enforcement-observed-execution/v4";
const RUNNER = "node-test-events-v1";
const RUNNER_REF = "scripts/lib/standards-enforcement-node-test-runner.mjs";
const OBSERVATION_SCHEMA = "standards-enforcement-node-test-events/v1";
const DEFAULT_OBSERVER_TIMEOUT_MS = 15_000;
const SHA256_RE = /^[a-f0-9]{64}$/;
const liveArtifacts = new WeakSet();

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

function isDeepFrozen(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).every((key) => isDeepFrozen(value[key], seen));
}

function safeRepoPath(rel) {
  return (
    typeof rel === "string" &&
    rel.length > 0 &&
    !path.isAbsolute(rel) &&
    !rel.includes("\0") &&
    !rel.split(/[\\/]/).includes("..")
  );
}

function occurrences(haystack, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function validObservation(value, observerRef) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (
    JSON.stringify(keys) !==
    JSON.stringify(
      [
        "assertionFailures",
        "decidingMessage",
        "failed",
        "observerRef",
        "passed",
        "schema",
        "source",
        "testsRun",
      ].sort(),
    )
  )
    return false;
  const counts = [
    value.testsRun,
    value.passed,
    value.failed,
    value.assertionFailures,
  ];
  return (
    value.schema === OBSERVATION_SCHEMA &&
    value.source === "node:test TestsStream" &&
    value.observerRef === observerRef &&
    counts.every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    ) &&
    value.testsRun === value.passed + value.failed &&
    value.assertionFailures <= value.failed &&
    typeof value.decidingMessage === "string" &&
    value.decidingMessage.length <= 500
  );
}

function scrubbedChildEnv() {
  const {
    NODE_OPTIONS: _nodeOptions,
    NODE_PATH: _nodePath,
    VITEST: _vitest,
    ...ambient
  } = process.env;
  return { ...ambient, NODE_NO_WARNINGS: "1" };
}

function runObserver(
  workspace,
  observerRef,
  guardId,
  kind,
  expectedRunnerSha256,
  timeoutMs = DEFAULT_OBSERVER_TIMEOUT_MS,
) {
  const runnerPath = path.join(workspace, RUNNER_REF);
  try {
    const stat = fs.lstatSync(runnerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("protected structured test runner is not a regular file");
    }
    const actualRunnerSha256 = sha256(fs.readFileSync(runnerPath));
    if (actualRunnerSha256 !== expectedRunnerSha256) {
      throw new Error(
        `protected structured test runner digest changed before execution: expected=${expectedRunnerSha256} actual=${actualRunnerSha256}`,
      );
    }
  } catch (error) {
    return Promise.resolve({
      guardId,
      kind,
      observerRef,
      runnerError: error instanceof Error ? error.message : String(error),
      timedOut: false,
    });
  }
  return new Promise((resolve) => {
    const argv = [
      process.execPath,
      runnerPath,
      observerRef,
      guardId,
      kind,
      RUNNER_REF,
    ];
    const startedAt = new Date().toISOString();
    const child = spawn(process.execPath, argv.slice(1), {
      cwd: workspace,
      env: scrubbedChildEnv(),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: process.platform !== "win32",
    });
    const stdout = [];
    const stderr = [];
    let spawnError = null;
    let timedOut = false;
    let settled = false;
    const events = [];
    const finish = (exitCode, signal, emittedAfterChildExit) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const childExitedAt = new Date().toISOString();
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      const output = `${stdoutText}${stderrText}`;
      resolve({
        guardId,
        kind,
        observerRef,
        childPid: child.pid,
        childExitCode: exitCode,
        signal,
        argv,
        startedAt,
        childExitedAt,
        emittedAfterChildExit,
        output,
        outputSha256: sha256(output),
        events,
        runnerError: null,
        spawnError,
        timedOut,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform !== "win32" && Number.isSafeInteger(child.pid)) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.connected) child.disconnect();
      finish(null, "SIGKILL", false);
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("message", (message) => events.push(message));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (exitCode, signal) => finish(exitCode, signal, true));
  });
}

async function authenticateRun(authority, run) {
  if (
    run.runnerError ||
    run.spawnError ||
    !Number.isSafeInteger(run.childPid) ||
    run.childPid <= 0 ||
    !Number.isSafeInteger(run.childExitCode) ||
    run.childExitCode < 0
  )
    return null;
  if (run.events.length !== 2) return null;
  const [readyEvent, observationEvent] = run.events;
  if (
    readyEvent?.kind !== "observer-ready" ||
    readyEvent?.runKind !== run.kind ||
    observationEvent?.kind !== run.kind ||
    !validObservation(observationEvent?.observation, run.observerRef) ||
    observationEvent.observationSha256 !==
      sha256(canonical(observationEvent.observation))
  )
    return null;
  const readyExpected = {
    kind: "observer-ready",
    guardId: run.guardId,
    nodeEntry: RUNNER_REF,
    observerPid: run.childPid,
    runKind: run.kind,
    argv: run.argv.slice(1),
  };
  if (
    !(await authority.pinObserverEvent(readyEvent, readyExpected)) ||
    !isLiveAuthenticatedObserverEvent(readyEvent)
  )
    return null;
  const observationExpected = {
    kind: run.kind,
    guardId: run.guardId,
    nodeEntry: RUNNER_REF,
    observerPid: run.childPid,
    observerSession: readyEvent.observerSession,
    argv: run.argv.slice(1),
    observation: observationEvent.observation,
    observationSha256: observationEvent.observationSha256,
  };
  if (
    !(await authority.authenticateObserverEvent(
      observationEvent,
      observationExpected,
    )) ||
    !isLiveAuthenticatedObserverEvent(observationEvent)
  )
    return null;
  const expected = {
    guardId: run.guardId,
    kind: run.kind,
    observerPid: run.childPid,
    childPid: run.childPid,
    childExitCode: run.childExitCode,
    argv: run.argv,
    startedAt: run.startedAt,
    childExitedAt: run.childExitedAt,
    emittedAfterChildExit: true,
    observerSession: observationEvent.observerSession,
    observerEventSequence: observationEvent.sequence,
    observerEventSignatureHash: sha256(observationEvent.signature),
  };
  const receipt = await authority.issue(expected);
  if (
    !(await authority.authenticate(receipt, expected)) ||
    !isLiveAuthenticatedReceipt(receipt)
  )
    return null;
  return Object.freeze({
    receipt,
    observation: Object.freeze({ ...observationEvent.observation }),
    observationEvent,
    observationSha256: observationEvent.observationSha256,
  });
}

function validatePlan(record) {
  const execution = record.proof.execution;
  const mutation = record.proof.mutation;
  const relevance = record.proof.relevance;
  if (
    execution.runner !== RUNNER ||
    !SHA256_RE.test(execution.runnerSha256) ||
    JSON.stringify(execution.argv) !==
      JSON.stringify(["node", RUNNER_REF, record.ref])
  ) {
    return "execution command is not the pinned node test runner for the observer";
  }
  if (
    !Array.isArray(execution.workspaceRefs) ||
    execution.workspaceRefs.length < 2 ||
    execution.workspaceRefs.some((ref) => !safeRepoPath(ref)) ||
    new Set(execution.workspaceRefs).size !== execution.workspaceRefs.length ||
    JSON.stringify([...execution.workspaceRefs].sort()) !==
      JSON.stringify(execution.workspaceRefs) ||
    execution.workspaceRefs.includes(RUNNER_REF) ||
    !execution.workspaceRefs.includes(record.ref) ||
    !execution.workspaceRefs.includes(relevance.subjectRef)
  ) {
    return "execution workspace is malformed or does not contain the observer and subject";
  }
  if (
    mutation.subjectRef !== relevance.subjectRef ||
    typeof mutation.search !== "string" ||
    mutation.search.length === 0 ||
    typeof mutation.replacement !== "string" ||
    mutation.replacement === mutation.search ||
    typeof mutation.mutationId !== "string" ||
    mutation.mutationId.trim().length < 3 ||
    !SHA256_RE.test(mutation.subjectAfterSha256)
  ) {
    return "subject mutation is malformed or crosses the declared relevance boundary";
  }
  return null;
}

function materialize(snapshot, refs, trustedRunnerContent) {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "standards-enforcement-observed-"),
  );
  try {
    for (const rel of refs) {
      const content = snapshot.readFile(rel);
      if (content === null)
        throw new Error(`protected workspace input unavailable: ${rel}`);
      const full = path.join(workspace, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, { flag: "wx" });
    }
    const runnerPath = path.join(workspace, RUNNER_REF);
    fs.mkdirSync(path.dirname(runnerPath), { recursive: true });
    fs.writeFileSync(runnerPath, trustedRunnerContent, { flag: "wx" });
    return { workspace, error: null };
  } catch (error) {
    return {
      workspace,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function cleanupWorkspaces(workspaces, suffix = "workspace-cleanup") {
  let firstError = null;
  for (const workspace of new Set(workspaces.filter(Boolean))) {
    try {
      SafeFsExecutor.safeRmSync(workspace, {
        recursive: true,
        force: true,
        operation: `standards-enforcement-execution-verifier:${suffix}`,
      });
    } catch (error) {
      if (firstError === null) firstError = error;
    }
  }
  if (firstError !== null) throw firstError;
}

function artifactFor(
  record,
  clean,
  mutated,
  confirmation,
  cleanAuthentication,
  mutatedAuthentication,
  confirmationAuthentication,
  mutationLanded,
) {
  const payload = {
    schema: ARTIFACT_SCHEMA,
    observer: {
      ref: record.ref,
      sha256: record.sha256,
      runner: RUNNER,
      runnerSha256: record.proof.execution.runnerSha256,
      structuredSource: "node:test TestsStream",
      argv: clean.argv,
    },
    subject: {
      ref: record.proof.relevance.subjectRef,
      beforeSha256: record.proof.relevance.subjectBeforeSha256,
      afterSha256: record.proof.mutation.subjectAfterSha256,
      mutationId: record.proof.mutation.mutationId,
      mutationLanded,
    },
    clean: {
      receipt: cleanAuthentication.receipt,
      observationEvent: cleanAuthentication.observationEvent,
      observationSha256: cleanAuthentication.observationSha256,
      exitCode: clean.childExitCode,
      testsRun: cleanAuthentication.observation.testsRun,
      passed: cleanAuthentication.observation.passed,
      failed: cleanAuthentication.observation.failed,
      assertionFailures: cleanAuthentication.observation.assertionFailures,
      decidingOutput: cleanAuthentication.observation.decidingMessage,
      outputSha256: clean.outputSha256,
    },
    mutated: {
      receipt: mutatedAuthentication.receipt,
      observationEvent: mutatedAuthentication.observationEvent,
      observationSha256: mutatedAuthentication.observationSha256,
      exitCode: mutated.childExitCode,
      testsRun: mutatedAuthentication.observation.testsRun,
      passed: mutatedAuthentication.observation.passed,
      failed: mutatedAuthentication.observation.failed,
      assertionFailures: mutatedAuthentication.observation.assertionFailures,
      outputSha256: mutated.outputSha256,
      decidingOutput: mutatedAuthentication.observation.decidingMessage,
    },
    confirmation: {
      receipt: confirmationAuthentication.receipt,
      observationEvent: confirmationAuthentication.observationEvent,
      observationSha256: confirmationAuthentication.observationSha256,
      exitCode: confirmation.childExitCode,
      testsRun: confirmationAuthentication.observation.testsRun,
      passed: confirmationAuthentication.observation.passed,
      failed: confirmationAuthentication.observation.failed,
      assertionFailures: confirmationAuthentication.observation.assertionFailures,
      decidingOutput: confirmationAuthentication.observation.decidingMessage,
      outputSha256: confirmation.outputSha256,
    },
  };
  const artifact = deepFreeze({
    ...payload,
    artifactSha256: sha256(canonical(payload)),
  });
  liveArtifacts.add(artifact);
  return artifact;
}

/**
 * The protected ledger chooses a subject and a mechanical mutation, but it cannot
 * state an execution outcome. All runs, structured observations, and receipts
 * are minted in this boundary from direct child-process observations.
 */
export async function verifyProtectedExecutionProof({
  record,
  snapshot,
  observerTimeoutMs = DEFAULT_OBSERVER_TIMEOUT_MS,
}) {
  const planError = validatePlan(record);
  if (planError)
    return { status: "unknown", reason: planError, artifact: null };

  let cleanWorkspace = null;
  let mutatedWorkspace = null;
  let confirmationWorkspace = null;
  let authority = null;
  const guardId = sha256(canonical({
    articleId: record.articleId,
    mutationId: record.proof.mutation.mutationId,
    ref: record.ref,
  }));
  try {
    const trustedRunnerContent = snapshot.readFile(RUNNER_REF);
    if (trustedRunnerContent === null)
      return {
        status: "unknown",
        reason: "protected structured test runner is unavailable",
        artifact: null,
      };
    const actualRunnerSha256 = sha256(trustedRunnerContent);
    if (actualRunnerSha256 !== record.proof.execution.runnerSha256)
      return {
        status: "unknown",
        reason: `protected structured test runner digest mismatch: expected=${record.proof.execution.runnerSha256} actual=${actualRunnerSha256}`,
        artifact: null,
      };
    const cleanMaterialization = materialize(
      snapshot,
      record.proof.execution.workspaceRefs,
      trustedRunnerContent,
    );
    cleanWorkspace = cleanMaterialization.workspace;
    if (cleanMaterialization.error)
      return {
        status: "unknown",
        reason: cleanMaterialization.error,
        artifact: null,
      };

    const mutatedMaterialization = materialize(
      snapshot,
      record.proof.execution.workspaceRefs,
      trustedRunnerContent,
    );
    mutatedWorkspace = mutatedMaterialization.workspace;
    if (mutatedMaterialization.error)
      return {
        status: "unknown",
        reason: mutatedMaterialization.error,
        artifact: null,
      };

    const confirmationMaterialization = materialize(
      snapshot,
      record.proof.execution.workspaceRefs,
      trustedRunnerContent,
    );
    confirmationWorkspace = confirmationMaterialization.workspace;
    if (confirmationMaterialization.error)
      return {
        status: "unknown",
        reason: confirmationMaterialization.error,
        artifact: null,
      };

    authority = await createAuthenticatedReceiptAuthority({
      issuer: "standards-enforcement-execution-verifier",
    });
    const clean = await runObserver(
      cleanWorkspace,
      record.ref,
      guardId,
      "clean-observer-exit",
      record.proof.execution.runnerSha256,
      observerTimeoutMs,
    );
    if (clean.runnerError)
      return { status: "unknown", reason: clean.runnerError, artifact: null };
    if (clean.timedOut)
      return {
        status: "unknown",
        reason: "clean observer execution timed out",
        artifact: null,
      };
    const cleanAuthentication = await authenticateRun(authority, clean);
    if (!cleanAuthentication)
      return {
        status: "unknown",
        reason: "clean structured test observation could not be authenticated",
        artifact: null,
      };

    const subjectPath = path.join(
      mutatedWorkspace,
      record.proof.relevance.subjectRef,
    );
    const before = fs.readFileSync(subjectPath, "utf8");
    const mutation = record.proof.mutation;
    if (
      sha256(before) !== record.proof.relevance.subjectBeforeSha256 ||
      occurrences(before, mutation.search) !== 1
    ) {
      return {
        status: "not-proven",
        reason:
          "declared subject mutation did not identify exactly one protected input",
        artifact: null,
      };
    }
    const after = before.replace(mutation.search, mutation.replacement);
    if (sha256(after) !== mutation.subjectAfterSha256) {
      return {
        status: "not-proven",
        reason:
          "declared subject mutation after-digest does not match the landed bytes",
        artifact: null,
      };
    }
    fs.writeFileSync(subjectPath, after);
    const mutationLanded = fs.readFileSync(subjectPath, "utf8") === after;
    if (!mutationLanded)
      return {
        status: "not-proven",
        reason: "declared subject mutation could not be landed",
        artifact: null,
      };

    const mutated = await runObserver(
      mutatedWorkspace,
      record.ref,
      guardId,
      "mutated-observer-exit",
      record.proof.execution.runnerSha256,
      observerTimeoutMs,
    );
    if (mutated.runnerError)
      return { status: "unknown", reason: mutated.runnerError, artifact: null };
    if (mutated.timedOut)
      return {
        status: "unknown",
        reason: "mutated observer execution timed out",
        artifact: null,
      };
    const mutatedAuthentication = await authenticateRun(authority, mutated);
    if (!mutatedAuthentication)
      return {
        status: "unknown",
        reason: "mutated structured test observation could not be authenticated",
        artifact: null,
      };

    const confirmation = await runObserver(
      confirmationWorkspace,
      record.ref,
      guardId,
      "confirmation-clean-observer-exit",
      record.proof.execution.runnerSha256,
      observerTimeoutMs,
    );
    if (confirmation.runnerError)
      return {
        status: "unknown",
        reason: confirmation.runnerError,
        artifact: null,
      };
    if (confirmation.timedOut)
      return {
        status: "unknown",
        reason: "confirmation observer execution timed out",
        artifact: null,
      };
    const confirmationAuthentication = await authenticateRun(
      authority,
      confirmation,
    );
    if (!confirmationAuthentication)
      return {
        status: "unknown",
        reason: "confirmation structured test observation could not be authenticated",
        artifact: null,
      };

    const artifact = artifactFor(
      record,
      clean,
      mutated,
      confirmation,
      cleanAuthentication,
      mutatedAuthentication,
      confirmationAuthentication,
      mutationLanded,
    );
    const cleanObservation = cleanAuthentication.observation;
    const mutatedObservation = mutatedAuthentication.observation;
    const confirmationObservation = confirmationAuthentication.observation;
    const cleanPassed =
      clean.childExitCode === 0 &&
      cleanObservation.testsRun > 0 &&
      cleanObservation.failed === 0;
    const sameTestsRan =
      Number.isInteger(cleanObservation.testsRun) &&
      cleanObservation.testsRun === mutatedObservation.testsRun &&
      cleanObservation.testsRun === confirmationObservation.testsRun;
    const confirmationPassed =
      confirmation.childExitCode === 0 &&
      confirmationObservation.testsRun > 0 &&
      confirmationObservation.failed === 0;
    const assertionFailure =
      mutated.childExitCode !== 0 &&
      mutatedObservation.testsRun > 0 &&
      mutatedObservation.failed > 0 &&
      mutatedObservation.assertionFailures > 0;
    if (!cleanPassed)
      return {
        status: "not-proven",
        reason: "clean observer did not pass executed tests",
        artifact,
      };
    if (mutated.childExitCode === 0)
      return {
        status: "not-proven",
        reason: "observer-survived-subject-mutation",
        artifact,
      };
    if (!confirmationPassed)
      return {
        status: "not-proven",
        reason: "observer-discrimination-did-not-reset-in-pristine-confirmation",
        artifact,
      };
    if (
      !sameTestsRan ||
      !assertionFailure
    ) {
      return {
        status: "not-proven",
        reason:
          "mutated observer did not execute the same tests to an assertion failure",
        artifact,
      };
    }
    return {
      status: "proven",
      reason: "authenticated-clean-and-mutated-executions-discriminate",
      artifact,
    };
  } catch (error) {
    return {
      status: "unknown",
      reason: `execution boundary unavailable: ${error instanceof Error ? error.message : String(error)}`,
      artifact: null,
    };
  } finally {
    if (authority !== null) {
      try {
        await authority.close();
      } catch {
        // close() terminates the worker in its own finally; classification was
        // already bound to live authenticated receipts before teardown.
      }
    }
    cleanupWorkspaces(
      [cleanWorkspace, mutatedWorkspace, confirmationWorkspace],
      "workspace-cleanup",
    );
  }
}

function artifactContentIsInternallyConsistent(artifact) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return false;
  if (!isDeepFrozen(artifact) || artifact.schema !== ARTIFACT_SCHEMA) return false;
  if (!SHA256_RE.test(artifact.artifactSha256 ?? "")) return false;
  const { artifactSha256, ...payload } = artifact;
  if (artifactSha256 !== sha256(canonical(payload))) return false;
  if (
    artifact.observer?.runner !== RUNNER ||
    !SHA256_RE.test(artifact.observer?.runnerSha256 ?? "") ||
    artifact.observer?.structuredSource !== "node:test TestsStream" ||
    !Array.isArray(artifact.observer?.argv) ||
    artifact.subject?.mutationLanded !== true
  )
    return false;

  const consistentRun = (run, expectedKind) => {
    const event = run?.observationEvent;
    const receipt = run?.receipt;
    const observation = event?.observation;
    return Boolean(
      event &&
      receipt &&
      validObservation(observation, artifact.observer?.ref) &&
      run.observationSha256 === sha256(canonical(observation)) &&
      event.observationSha256 === run.observationSha256 &&
      run.testsRun === observation.testsRun &&
      run.passed === observation.passed &&
      run.failed === observation.failed &&
      run.assertionFailures === observation.assertionFailures &&
      run.decidingOutput === observation.decidingMessage &&
      run.exitCode === receipt.childExitCode &&
      event.kind === expectedKind &&
      receipt.observerSession === event.observerSession &&
      receipt.observerEventSequence === event.sequence &&
      receipt.observerEventSignatureHash === sha256(event.signature) &&
      receipt.kind === event.kind &&
      receipt.guardId === event.guardId &&
      receipt.observerPid === event.observerPid &&
      receipt.childPid === event.observerPid &&
      canonical(receipt.argv?.slice(1)) === canonical(event.argv)
    );
  };

  return Boolean(
    canonical(artifact.observer.argv) === canonical(artifact.clean?.receipt?.argv) &&
    consistentRun(artifact.clean, "clean-observer-exit") &&
    consistentRun(artifact.mutated, "mutated-observer-exit") &&
    consistentRun(artifact.confirmation, "confirmation-clean-observer-exit")
  );
}

export function isLiveAuthenticatedExecutionArtifact(artifact) {
  const liveRun = (run) => Boolean(
    isLiveAuthenticatedObserverEvent(run?.observationEvent) &&
    isLiveAuthenticatedReceipt(run?.receipt)
  );
  return Boolean(
    liveArtifacts.has(artifact) &&
    artifactContentIsInternallyConsistent(artifact) &&
    liveRun(artifact.clean) &&
    liveRun(artifact.mutated) &&
    liveRun(artifact.confirmation)
  );
}

export const __testing = Object.freeze({
  artifactContentIsInternallyConsistent,
});

export const STANDARDS_EXECUTION_ARTIFACT_SCHEMA = ARTIFACT_SCHEMA;
export const STANDARDS_EXECUTION_RUNNER = RUNNER;
export const STANDARDS_EXECUTION_RUNNER_REF = RUNNER_REF;
export const STANDARDS_EXECUTION_DEFAULT_TIMEOUT_MS = DEFAULT_OBSERVER_TIMEOUT_MS;
