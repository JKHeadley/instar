/**
 * Process-wide handle to the inbound ASP classifier.
 *
 * The classifier is built in the messaging wiring (commands/server.ts) AFTER
 * the HTTP route context exists (server/AgentServer.ts), and both the polling
 * ingress and the lifeline-forward ingress must read the SAME classifier's
 * verdicts (single-use nonce: a message is verified once, at log time, and
 * every later reader asks this one instance). A module-level reference is the
 * smallest seam that lets both read it without a construction-order dance.
 */
import type { AspInboundClassifier } from './AspInboundClassifier.js';

let ref: AspInboundClassifier | null = null;

export function setAspClassifierRef(classifier: AspInboundClassifier | null): void {
  ref = classifier;
}

export function getAspClassifierRef(): AspInboundClassifier | null {
  return ref;
}
