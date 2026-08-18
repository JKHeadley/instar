import path from "node:path";
import { run } from "node:test";

const SCHEMA = "standards-enforcement-node-test-events/v1";

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

async function send(summary) {
  if (typeof process.send !== "function") {
    throw new Error("structured observation IPC is unavailable");
  }
  await new Promise((resolve, reject) => {
    process.send(summary, (error) => (error ? reject(error) : resolve()));
  });
  if (process.connected) process.disconnect();
}

const observerRef = process.argv[2];
if (typeof observerRef !== "string" || observerRef.length === 0) {
  throw new Error("observer reference is required");
}

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
await send(summary);
