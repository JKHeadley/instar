import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createAuthenticatedReceiptAuthority,
  isLiveAuthenticatedReceipt,
} from "../../scratchpad/phaseB/authenticated-execution-receipt.mjs";
import { SafeFsExecutor } from "../../dist/core/SafeFsExecutor.js";

const ARTIFACT_SCHEMA = "standards-enforcement-observed-execution/v2";
const RUNNER = "node-test-events-v1";
const RUNNER_REF = "scripts/lib/standards-enforcement-node-test-runner.mjs";
const RUNNER_PATH = fileURLToPath(
  new URL("./standards-enforcement-node-test-runner.mjs", import.meta.url),
);
const OBSERVATION_SCHEMA = "standards-enforcement-node-test-events/v1";
const DEFAULT_OBSERVER_TIMEOUT_MS = 15_000;
const SHA256_RE = /^[a-f0-9]{64}$/;
const liveArtifacts = new WeakSet();

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

function runnerDigest() {
  const stat = fs.lstatSync(RUNNER_PATH);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("structured test runner must be a regular non-symlink file");
  }
  return sha256(fs.readFileSync(RUNNER_PATH));
}

const RUNNER_SHA256 = runnerDigest();

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
  timeoutMs = DEFAULT_OBSERVER_TIMEOUT_MS,
) {
  return new Promise((resolve) => {
    const argv = [process.execPath, RUNNER_PATH, observerRef];
    const startedAt = new Date().toISOString();
    const child = spawn(process.execPath, [RUNNER_PATH, observerRef], {
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
    const observations = [];
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
        childPid: child.pid,
        childExitCode: exitCode,
        signal,
        argv,
        startedAt,
        childExitedAt,
        emittedAfterChildExit,
        output,
        outputSha256: sha256(output),
        observation:
          observations.length === 1 &&
          validObservation(observations[0], observerRef)
            ? observations[0]
            : null,
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
    child.on("message", (message) => observations.push(message));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (exitCode, signal) => finish(exitCode, signal, true));
  });
}

async function authenticateRun(authority, run) {
  if (
    run.spawnError ||
    !Number.isSafeInteger(run.childPid) ||
    run.childPid <= 0 ||
    !Number.isSafeInteger(run.childExitCode) ||
    run.childExitCode < 0
  )
    return null;
  const expected = {
    guardId: run.guardId,
    kind: run.kind,
    childPid: run.childPid,
    childExitCode: run.childExitCode,
    argv: run.argv,
    startedAt: run.startedAt,
    childExitedAt: run.childExitedAt,
    emittedAfterChildExit: true,
  };
  const receipt = await authority.issue(expected);
  if (
    !(await authority.authenticate(receipt, expected)) ||
    !isLiveAuthenticatedReceipt(receipt)
  )
    return null;
  return receipt;
}

function validatePlan(record) {
  const execution = record.proof.execution;
  const mutation = record.proof.mutation;
  const relevance = record.proof.relevance;
  if (
    execution.runner !== RUNNER ||
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

function materialize(snapshot, refs) {
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
  cleanReceipt,
  mutatedReceipt,
  confirmationReceipt,
  mutationLanded,
) {
  const payload = {
    schema: ARTIFACT_SCHEMA,
    observer: {
      ref: record.ref,
      sha256: record.sha256,
      runner: RUNNER,
      runnerSha256: RUNNER_SHA256,
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
      receipt: cleanReceipt,
      exitCode: clean.childExitCode,
      testsRun: clean.observation.testsRun,
      passed: clean.observation.passed,
      failed: clean.observation.failed,
      outputSha256: clean.outputSha256,
    },
    mutated: {
      receipt: mutatedReceipt,
      exitCode: mutated.childExitCode,
      testsRun: mutated.observation.testsRun,
      passed: mutated.observation.passed,
      failed: mutated.observation.failed,
      assertionFailures: mutated.observation.assertionFailures,
      outputSha256: mutated.outputSha256,
      decidingOutput: mutated.observation.decidingMessage,
    },
    confirmation: {
      receipt: confirmationReceipt,
      exitCode: confirmation.childExitCode,
      testsRun: confirmation.observation.testsRun,
      passed: confirmation.observation.passed,
      failed: confirmation.observation.failed,
      outputSha256: confirmation.outputSha256,
    },
  };
  const artifact = Object.freeze({
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
  const guardId = `${record.articleId}\0${record.ref}\0${record.proof.mutation.mutationId}`;
  try {
    const cleanMaterialization = materialize(
      snapshot,
      record.proof.execution.workspaceRefs,
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
      observerTimeoutMs,
    );
    if (clean.timedOut)
      return {
        status: "unknown",
        reason: "clean observer execution timed out",
        artifact: null,
      };
    const cleanReceipt = await authenticateRun(authority, clean);
    if (!cleanReceipt)
      return {
        status: "unknown",
        reason: "clean observer execution could not be authenticated",
        artifact: null,
      };
    if (clean.observation === null)
      return {
        status: "unknown",
        reason: "clean structured test observation unavailable",
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
      observerTimeoutMs,
    );
    if (mutated.timedOut)
      return {
        status: "unknown",
        reason: "mutated observer execution timed out",
        artifact: null,
      };
    const mutatedReceipt = await authenticateRun(authority, mutated);
    if (!mutatedReceipt)
      return {
        status: "unknown",
        reason: "mutated observer execution could not be authenticated",
        artifact: null,
      };
    if (mutated.observation === null)
      return {
        status: "unknown",
        reason: "mutated structured test observation unavailable",
        artifact: null,
      };

    const confirmation = await runObserver(
      confirmationWorkspace,
      record.ref,
      guardId,
      "confirmation-clean-observer-exit",
      observerTimeoutMs,
    );
    if (confirmation.timedOut)
      return {
        status: "unknown",
        reason: "confirmation observer execution timed out",
        artifact: null,
      };
    const confirmationReceipt = await authenticateRun(authority, confirmation);
    if (!confirmationReceipt)
      return {
        status: "unknown",
        reason: "confirmation observer execution could not be authenticated",
        artifact: null,
      };
    if (confirmation.observation === null)
      return {
        status: "unknown",
        reason: "confirmation structured test observation unavailable",
        artifact: null,
      };

    const artifact = artifactFor(
      record,
      clean,
      mutated,
      confirmation,
      cleanReceipt,
      mutatedReceipt,
      confirmationReceipt,
      mutationLanded,
    );
    const cleanPassed =
      clean.childExitCode === 0 &&
      clean.observation.testsRun > 0 &&
      clean.observation.failed === 0;
    const sameTestsRan =
      Number.isInteger(clean.observation.testsRun) &&
      clean.observation.testsRun === mutated.observation.testsRun &&
      clean.observation.testsRun === confirmation.observation.testsRun;
    const confirmationPassed =
      confirmation.childExitCode === 0 &&
      confirmation.observation.testsRun > 0 &&
      confirmation.observation.failed === 0;
    const assertionFailure =
      mutated.childExitCode !== 0 &&
      mutated.observation.testsRun > 0 &&
      mutated.observation.failed > 0 &&
      mutated.observation.assertionFailures > 0;
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

export function isLiveAuthenticatedExecutionArtifact(artifact) {
  return Boolean(
    artifact &&
    typeof artifact === "object" &&
    liveArtifacts.has(artifact) &&
    isLiveAuthenticatedReceipt(artifact.clean?.receipt) &&
    isLiveAuthenticatedReceipt(artifact.mutated?.receipt) &&
    isLiveAuthenticatedReceipt(artifact.confirmation?.receipt),
  );
}

export const STANDARDS_EXECUTION_ARTIFACT_SCHEMA = ARTIFACT_SCHEMA;
export const STANDARDS_EXECUTION_RUNNER = RUNNER;
export const STANDARDS_EXECUTION_DEFAULT_TIMEOUT_MS = DEFAULT_OBSERVER_TIMEOUT_MS;
