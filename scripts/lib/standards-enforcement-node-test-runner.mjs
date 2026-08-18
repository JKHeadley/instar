import crypto from "node:crypto";
import path from "node:path";
import { run } from "node:test";

const SCHEMA = "standards-enforcement-node-test-events/v1";
const EVENT_SCHEMA = "phaseB-authenticated-observer-event/v1";

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

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

function assertionError(error, seen = new Set()) {
  if (!error || typeof error !== "object" || seen.has(error)) return null;
  seen.add(error);
  if (error.code === "ERR_ASSERTION" || error.name === "AssertionError") {
    return error;
  }
  const caused = assertionError(error.cause, seen);
  if (caused) return caused;
  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) {
      const found = assertionError(nested, seen);
      if (found) return found;
    }
  }
  return null;
}

function countedTest(data) {
  return (
    data &&
    typeof data === "object" &&
    data.details?.type !== "suite" &&
    !data.skip &&
    !data.todo
  );
}

async function send(message) {
  if (typeof process.send !== "function") {
    throw new Error("structured observation IPC is unavailable");
  }
  await new Promise((resolve, reject) => {
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

const observerRef = process.argv[2];
const guardId = process.argv[3];
const runKind = process.argv[4];
const nodeEntry = process.argv[5];
if (typeof observerRef !== "string" || observerRef.length === 0) {
  throw new Error("observer reference is required");
}
if (typeof guardId !== "string" || guardId.length === 0) {
  throw new Error("guard identity is required");
}
if (typeof runKind !== "string" || runKind.length === 0) {
  throw new Error("run kind is required");
}
if (typeof nodeEntry !== "string" || nodeEntry.length === 0) {
  throw new Error("runner entry identity is required");
}

const keyPair = crypto.generateKeyPairSync("ed25519");
const publicKey = keyPair.publicKey
  .export({ type: "spki", format: "der" })
  .toString("base64");
const observerSession = crypto.randomUUID();
const argv = process.argv.slice(1);
let sequence = 0;
async function emit(kind, fields = {}) {
  const event = {
    eventSchema: EVENT_SCHEMA,
    source: "fix-verifier-observer",
    observerSession,
    sequence: ++sequence,
    kind,
    guardId,
    nodeEntry,
    observerPid: process.pid,
    argv,
    ...(kind === "observer-ready" ? { publicKey } : {}),
    ...fields,
  };
  const signature = crypto
    .sign(null, Buffer.from(canonical(event)), keyPair.privateKey)
    .toString("base64");
  await send({ ...event, signature });
}

await emit("observer-ready", { runKind });

let passed = 0;
let failed = 0;
let assertionFailures = 0;
let decidingMessage = "";
const stream = run({
  files: [path.resolve(observerRef)],
  concurrency: false,
});

for await (const event of stream) {
  if (event.type === "test:pass" && countedTest(event.data)) {
    passed += 1;
  } else if (event.type === "test:fail" && countedTest(event.data)) {
    failed += 1;
    const assertion = assertionError(event.data.details?.error);
    if (assertion) {
      assertionFailures += 1;
      if (!decidingMessage) {
        decidingMessage = `${assertion.name ?? "AssertionError"}${
          assertion.code ? ` [${assertion.code}]` : ""
        }: ${assertion.message ?? "assertion failed"}`.slice(0, 500);
      }
    }
  }
}

const summary = Object.freeze({
  schema: SCHEMA,
  source: "node:test TestsStream",
  observerRef,
  testsRun: passed + failed,
  passed,
  failed,
  assertionFailures,
  decidingMessage,
});
process.exitCode = failed > 0 ? 1 : 0;
await emit(runKind, {
  observation: summary,
  observationSha256: sha256(canonical(summary)),
});
if (process.connected) process.disconnect();
