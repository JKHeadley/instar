import fs from 'node:fs';
import path from 'node:path';

export const BETWEEN_WINDOW_OBSERVER_TOPIC_ID = 43003;

export interface CorpusSide {
  observer: string;
  source: string;
  messages: number;
  authors: number;
}

export interface CorpusMismatch {
  scope: string;
  observer1: CorpusSide;
  observer2: CorpusSide;
}

export interface AdmissionIssue {
  code:
    | 'PACKAGE_SHAPE_INVALID'
    | 'STORE_UNREADABLE'
    | 'WINDOW_ONLY_READ'
    | 'RECEIPT_NOT_IN_STORE'
    | 'RECEIPT_FIELD_MISSING'
    | 'OBSERVER_RECEIPT_MISSING'
    | 'COUNT_WITHOUT_HASH_OR_RULE'
    | 'POSTED_ASSESSMENT_MISSING_FROM_STORE'
    | 'AGENT_ACCOUNT_CLASSIFIED_AS_JUSTIN'
    | 'TENET_RECEIPT_MISSING'
    | 'KNOWN_CORPUS_MISMATCH_NOT_SURFACED';
  path: string;
  message: string;
}

export interface AdmissionResult {
  admitted: boolean;
  issues: AdmissionIssue[];
  checked: {
    observerReceiptTopicId: number;
    fullHistoryReceipts: number;
    tenetReceipts: number;
    storePath: string;
    storeMessages: number;
  };
  corpusMismatches: CorpusMismatch[];
}

export interface EvaluateBetweenWindowAdmissionOptions {
  stateDir: string;
  package: unknown;
  storePath?: string;
}

interface StoredMessage {
  topicId: number;
  messageId: number;
  text: string;
}

const REQUIRED_MISMATCHES: CorpusMismatch[] = [
  {
    scope: 'pathway',
    observer1: { observer: 'observer-1', source: 'union archive', messages: 2469, authors: 137 },
    observer2: { observer: 'observer-2', source: 'store', messages: 2809, authors: 122 },
  },
  {
    scope: 'observer-1-topic-36966',
    observer1: { observer: 'observer-1', source: 'union archive', messages: 1448, authors: 299 },
    observer2: { observer: 'observer-2', source: 'store', messages: 1503, authors: 289 },
  },
];
const REQUIRED_OBSERVERS = ['observer-1', 'observer-2'] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function sha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/i.test(value.trim());
}

function topicOf(value: Record<string, unknown>): number | null {
  const raw = value.topicId ?? value.topic_id;
  return positiveInteger(raw) ? raw : null;
}

function messageIdOf(value: Record<string, unknown>): number | null {
  const raw = value.messageId ?? value.message_id;
  return positiveInteger(raw) ? raw : null;
}

function key(topicId: number, messageId: number): string {
  return `${topicId}:${messageId}`;
}

export function loadTelegramJsonlStore(stateDir: string, overridePath?: string): {
  path: string;
  messages: Map<string, StoredMessage>;
  issue?: AdmissionIssue;
} {
  const storePath = overridePath
    ? path.resolve(overridePath)
    : path.join(stateDir, 'telegram-messages.jsonl');
  const messages = new Map<string, StoredMessage>();

  let raw: string;
  try {
    raw = fs.readFileSync(storePath, 'utf-8');
  } catch (err) {
    return {
      path: storePath,
      messages,
      issue: {
        code: 'STORE_UNREADABLE',
        path: 'store',
        message: `telegram message store is unreadable at ${storePath}: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  for (const [idx, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isObject(parsed)) continue;
      const topicId = topicOf(parsed);
      const messageId = messageIdOf(parsed);
      if (!topicId || !messageId) continue;
      messages.set(key(topicId, messageId), {
        topicId,
        messageId,
        text: typeof parsed.text === 'string' ? parsed.text : '',
      });
    } catch {
      return {
        path: storePath,
        messages,
        issue: {
          code: 'STORE_UNREADABLE',
          path: `store.line.${idx + 1}`,
          message: `telegram message store contains malformed JSON at line ${idx + 1}`,
        },
      };
    }
  }

  return { path: storePath, messages };
}

function requireField(
  issues: AdmissionIssue[],
  obj: Record<string, unknown>,
  field: string,
  issuePath: string,
): unknown {
  const value = obj[field];
  if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
    issues.push({
      code: 'RECEIPT_FIELD_MISSING',
      path: issuePath,
      message: `${issuePath} is required`,
    });
  }
  return value;
}

function requireStoredMessage(
  issues: AdmissionIssue[],
  store: Map<string, StoredMessage>,
  topicId: number,
  messageId: number,
  issuePath: string,
  code: AdmissionIssue['code'] = 'RECEIPT_NOT_IN_STORE',
): void {
  if (!store.has(key(topicId, messageId))) {
    issues.push({
      code,
      path: issuePath,
      message: `message ${messageId} is absent from topic ${topicId} in the telegram store`,
    });
  }
}

function validateStoredMessageIds(
  issues: AdmissionIssue[],
  store: Map<string, StoredMessage>,
  ids: unknown,
  defaultTopicId: number,
  issuePath: string,
  code: AdmissionIssue['code'] = 'RECEIPT_NOT_IN_STORE',
): void {
  if (!Array.isArray(ids) || ids.length === 0) {
    issues.push({ code: 'RECEIPT_FIELD_MISSING', path: issuePath, message: `${issuePath} must name stored message ids` });
    return;
  }

  ids.forEach((entry, idx) => {
    if (positiveInteger(entry)) {
      requireStoredMessage(issues, store, defaultTopicId, entry, `${issuePath}.${idx}`, code);
      return;
    }
    if (isObject(entry)) {
      const topicId = topicOf(entry) ?? defaultTopicId;
      const messageId = messageIdOf(entry);
      if (!messageId) {
        issues.push({ code: 'RECEIPT_FIELD_MISSING', path: `${issuePath}.${idx}.messageId`, message: 'stored message id entry must name a message id' });
        return;
      }
      requireStoredMessage(issues, store, topicId, messageId, `${issuePath}.${idx}`, code);
      return;
    }
    issues.push({ code: 'RECEIPT_FIELD_MISSING', path: `${issuePath}.${idx}`, message: 'stored message id entry must be a positive integer or {topicId,messageId}' });
  });
}

function validateFullHistoryReceipt(
  issues: AdmissionIssue[],
  receiptRef: unknown,
  store: Map<string, StoredMessage>,
  idx: number,
): string | null {
  const base = `fullHistoryReceipts.${idx}`;
  if (!isObject(receiptRef)) {
    issues.push({ code: 'PACKAGE_SHAPE_INVALID', path: base, message: 'full-history receipt entry must be an object' });
    return null;
  }

  const topicId = topicOf(receiptRef) ?? BETWEEN_WINDOW_OBSERVER_TOPIC_ID;
  const messageId = messageIdOf(receiptRef);
  if (topicId !== BETWEEN_WINDOW_OBSERVER_TOPIC_ID) {
    issues.push({ code: 'RECEIPT_NOT_IN_STORE', path: `${base}.topicId`, message: `observer receipt must be posted in topic ${BETWEEN_WINDOW_OBSERVER_TOPIC_ID}` });
  }
  if (!messageId) {
    issues.push({ code: 'RECEIPT_FIELD_MISSING', path: `${base}.messageId`, message: 'receipt store message id is required' });
  } else {
    requireStoredMessage(issues, store, topicId, messageId, `${base}.messageId`);
  }

  const receipt = isObject(receiptRef.receipt) ? receiptRef.receipt : receiptRef;
  const observer = receiptRef.observer ?? receipt.observer ?? receiptRef.observerId ?? receipt.observerId;
  if (!nonEmptyString(observer)) {
    issues.push({
      code: 'OBSERVER_RECEIPT_MISSING',
      path: `${base}.observer`,
      message: 'full-history receipt must name observer-1 or observer-2',
    });
  }
  const historyScope = receipt.historyScope ?? receipt.readScope ?? receipt.sourceScope;
  if (historyScope !== 'full-history') {
    issues.push({
      code: 'WINDOW_ONLY_READ',
      path: `${base}.historyScope`,
      message: 'receipt must be a full-history read, not a window-only read',
    });
  }

  const canonicalSource = requireField(issues, receipt, 'canonicalSource', `${base}.canonicalSource`);
  const canonicalStore = requireField(issues, receipt, 'canonicalStore', `${base}.canonicalStore`);
  const dateSpan = requireField(issues, receipt, 'dateSpan', `${base}.dateSpan`);
  const population = requireField(issues, receipt, 'population', `${base}.population`);
  const extractionContract = requireField(issues, receipt, 'extractionContract', `${base}.extractionContract`);
  const dedupeContract = requireField(issues, receipt, 'dedupeContract', `${base}.dedupeContract`);
  const semanticArtifact = requireField(issues, receipt, 'semanticAuthorArtifact', `${base}.semanticAuthorArtifact`);
  const corpusHash = requireField(issues, receipt, 'corpusHash', `${base}.corpusHash`);
  const quotes = requireField(issues, receipt, 'quotes', `${base}.quotes`);
  const assessment = requireField(issues, receipt, 'assessment', `${base}.assessment`);
  const storedMessageIds = requireField(issues, receipt, 'storedMessageIds', `${base}.storedMessageIds`);

  if (!isObject(canonicalSource) || !nonEmptyString(canonicalSource.name ?? canonicalSource.uri ?? canonicalSource.path)) {
    issues.push({ code: 'RECEIPT_FIELD_MISSING', path: `${base}.canonicalSource.name`, message: 'canonical source must name a source' });
  }
  if (!isObject(canonicalStore) || !nonEmptyString(canonicalStore.name ?? canonicalStore.uri ?? canonicalStore.path ?? canonicalStore.type)) {
    issues.push({ code: 'RECEIPT_FIELD_MISSING', path: `${base}.canonicalStore.name`, message: 'canonical store must name a store' });
  }

  const hasCounts = isObject(population) && (positiveInteger(population.messages) || positiveInteger(population.messageCount));
  const hasExtractionRule = isObject(extractionContract) && nonEmptyString(extractionContract.rule);
  const hasDedupeRule = isObject(dedupeContract) && nonEmptyString(dedupeContract.rule);
  if (!isObject(dateSpan) || !nonEmptyString(dateSpan.from) || !nonEmptyString(dateSpan.to)) {
    issues.push({ code: 'RECEIPT_FIELD_MISSING', path: `${base}.dateSpan`, message: 'date span must name from and to' });
  }
  if (!isObject(population) || !hasCounts || !positiveInteger(population.authors ?? population.authorCount)) {
    issues.push({ code: 'RECEIPT_FIELD_MISSING', path: `${base}.population`, message: 'population must name message and author counts' });
  }
  if (hasCounts && (!nonEmptyString(corpusHash) || !hasExtractionRule || !hasDedupeRule)) {
    issues.push({
      code: 'COUNT_WITHOUT_HASH_OR_RULE',
      path: base,
      message: 'population counts require corpusHash plus extractionContract.rule and dedupeContract.rule',
    });
  }
  if (nonEmptyString(corpusHash) && !sha256Digest(corpusHash)) {
    issues.push({
      code: 'RECEIPT_FIELD_MISSING',
      path: `${base}.corpusHash`,
      message: 'corpusHash must be sha256:<64 hex characters>',
    });
  }
  if (!Array.isArray(quotes) || quotes.length === 0) {
    issues.push({ code: 'RECEIPT_FIELD_MISSING', path: `${base}.quotes`, message: 'receipt must include quote evidence' });
  }

  if (isObject(semanticArtifact)) {
    const agentRows = semanticArtifact.agentThroughOperatorRows;
    const justinRows = semanticArtifact.justinRows;
    if (!Array.isArray(agentRows) || agentRows.length === 0) {
      issues.push({ code: 'RECEIPT_FIELD_MISSING', path: `${base}.semanticAuthorArtifact.agentThroughOperatorRows`, message: 'agent-through-operator rows are required' });
    }
    if (!Array.isArray(justinRows) || justinRows.length === 0) {
      issues.push({ code: 'RECEIPT_FIELD_MISSING', path: `${base}.semanticAuthorArtifact.justinRows`, message: "Justin's rows are required and must be separate" });
    }
    for (const [rowIdx, row] of [...(Array.isArray(agentRows) ? agentRows : []), ...(Array.isArray(justinRows) ? justinRows : [])].entries()) {
      if (!isObject(row)) continue;
      const classifiedAs = row.classifiedAs ?? row.classification ?? row.authorClass;
      if (row.accountKind === 'agent' && classifiedAs === 'justin') {
        issues.push({
          code: 'AGENT_ACCOUNT_CLASSIFIED_AS_JUSTIN',
          path: `${base}.semanticAuthorArtifact.rows.${rowIdx}`,
          message: 'agent-account row is classified as Justin',
        });
      }
    }
  }

  validateStoredMessageIds(issues, store, storedMessageIds, BETWEEN_WINDOW_OBSERVER_TOPIC_ID, `${base}.storedMessageIds`);

  if (isObject(assessment)) {
    if (!nonEmptyString(assessment.summary)) {
      issues.push({ code: 'RECEIPT_FIELD_MISSING', path: `${base}.assessment.summary`, message: 'assessment summary is required' });
    }
    if (assessment.status === 'posted') {
      validateStoredMessageIds(
        issues,
        store,
        assessment.storedMessageIds,
        BETWEEN_WINDOW_OBSERVER_TOPIC_ID,
        `${base}.assessment.storedMessageIds`,
        'POSTED_ASSESSMENT_MISSING_FROM_STORE',
      );
    }
  }

  return nonEmptyString(observer) ? observer : null;
}

function validateTenetReceipts(
  issues: AdmissionIssue[],
  refs: unknown,
  store: Map<string, StoredMessage>,
): void {
  if (!Array.isArray(refs)) {
    issues.push({ code: 'TENET_RECEIPT_MISSING', path: 'tenetReaffirmationReceipts', message: 'start, middle, and end tenet reaffirmation receipts are required' });
    return;
  }
  const phases = new Set<string>();
  for (const [idx, ref] of refs.entries()) {
    const base = `tenetReaffirmationReceipts.${idx}`;
    if (!isObject(ref)) {
      issues.push({ code: 'TENET_RECEIPT_MISSING', path: base, message: 'tenet receipt entry must be an object' });
      continue;
    }
    const phase = typeof ref.phase === 'string' ? ref.phase : '';
    if (phase) phases.add(phase);
    const topicId = topicOf(ref);
    const messageId = messageIdOf(ref);
    if (!topicId || !messageId) {
      issues.push({ code: 'TENET_RECEIPT_MISSING', path: base, message: 'tenet receipt must name topicId and messageId' });
    } else {
      requireStoredMessage(issues, store, topicId, messageId, `${base}.messageId`, 'TENET_RECEIPT_MISSING');
    }
    const receipt = isObject(ref.receipt) ? ref.receipt : ref;
    const hash = receipt.corpusHash ?? receipt.textHash;
    if (!nonEmptyString(receipt.canonicalStore ?? receipt.store) || !sha256Digest(hash)) {
      issues.push({ code: 'TENET_RECEIPT_MISSING', path: `${base}.receipt`, message: 'tenet receipt must name its store and text/corpus hash' });
    }
  }

  for (const required of ['start', 'middle', 'end']) {
    if (!phases.has(required)) {
      issues.push({ code: 'TENET_RECEIPT_MISSING', path: `tenetReaffirmationReceipts.${required}`, message: `${required} tenet reaffirmation receipt is missing` });
    }
  }
}

function normalizeMismatch(mismatch: CorpusMismatch): string {
  return [
    mismatch.scope,
    mismatch.observer1.source,
    mismatch.observer1.messages,
    mismatch.observer1.authors,
    mismatch.observer2.source,
    mismatch.observer2.messages,
    mismatch.observer2.authors,
  ].join('|').toLowerCase();
}

function coerceMismatch(raw: unknown): CorpusMismatch | null {
  if (!isObject(raw) || !nonEmptyString(raw.scope) || !isObject(raw.observer1) || !isObject(raw.observer2)) {
    return null;
  }
  const o1 = raw.observer1;
  const o2 = raw.observer2;
  if (
    !nonEmptyString(o1.observer) ||
    !nonEmptyString(o1.source) ||
    !positiveInteger(o1.messages) ||
    !positiveInteger(o1.authors) ||
    !nonEmptyString(o2.observer) ||
    !nonEmptyString(o2.source) ||
    !positiveInteger(o2.messages) ||
    !positiveInteger(o2.authors)
  ) {
    return null;
  }
  return {
    scope: raw.scope,
    observer1: { observer: o1.observer, source: o1.source, messages: o1.messages, authors: o1.authors },
    observer2: { observer: o2.observer, source: o2.source, messages: o2.messages, authors: o2.authors },
  };
}

function readMismatches(pkg: Record<string, unknown>, issues: AdmissionIssue[]): CorpusMismatch[] {
  const raw = pkg.knownCorpusMismatches ?? pkg.corpusMismatches;
  if (!Array.isArray(raw)) return [];
  const out: CorpusMismatch[] = [];
  raw.forEach((entry, idx) => {
    const coerced = coerceMismatch(entry);
    if (coerced) {
      out.push(coerced);
    } else {
      issues.push({
        code: 'KNOWN_CORPUS_MISMATCH_NOT_SURFACED',
        path: `knownCorpusMismatches.${idx}`,
        message: 'corpus mismatch disclosure must name scope and both observer populations',
      });
    }
  });
  return out;
}

export function evaluateBetweenWindowAdmission(options: EvaluateBetweenWindowAdmissionOptions): AdmissionResult {
  const store = loadTelegramJsonlStore(options.stateDir, options.storePath);
  const issues: AdmissionIssue[] = [];
  if (store.issue) issues.push(store.issue);

  if (!isObject(options.package)) {
    issues.push({ code: 'PACKAGE_SHAPE_INVALID', path: 'package', message: 'admission package must be a JSON object' });
    return {
      admitted: false,
      issues,
      checked: {
        observerReceiptTopicId: BETWEEN_WINDOW_OBSERVER_TOPIC_ID,
        fullHistoryReceipts: 0,
        tenetReceipts: 0,
        storePath: store.path,
        storeMessages: store.messages.size,
      },
      corpusMismatches: [],
    };
  }

  const fullHistoryReceipts = options.package.fullHistoryReceipts;
  if (!Array.isArray(fullHistoryReceipts) || fullHistoryReceipts.length < 2) {
    issues.push({ code: 'RECEIPT_FIELD_MISSING', path: 'fullHistoryReceipts', message: "both observers' full-history receipts are required" });
  } else {
    const observers = new Set<string>();
    fullHistoryReceipts.forEach((receipt, idx) => {
      const observer = validateFullHistoryReceipt(issues, receipt, store.messages, idx);
      if (observer) observers.add(observer);
    });
    for (const requiredObserver of REQUIRED_OBSERVERS) {
      if (!observers.has(requiredObserver)) {
        issues.push({
          code: 'OBSERVER_RECEIPT_MISSING',
          path: `fullHistoryReceipts.${requiredObserver}`,
          message: `full-history receipt for ${requiredObserver} is required`,
        });
      }
    }
  }

  validateTenetReceipts(issues, options.package.tenetReaffirmationReceipts, store.messages);

  const surfacedMismatches = readMismatches(options.package, issues);
  const actual = new Set(surfacedMismatches.map(normalizeMismatch));
  for (const required of REQUIRED_MISMATCHES) {
    if (!actual.has(normalizeMismatch(required))) {
      issues.push({
        code: 'KNOWN_CORPUS_MISMATCH_NOT_SURFACED',
        path: `knownCorpusMismatches.${required.scope}`,
        message: `known corpus mismatch is not surfaced: ${required.scope}`,
      });
    }
  }

  return {
    admitted: issues.length === 0,
    issues,
    checked: {
      observerReceiptTopicId: BETWEEN_WINDOW_OBSERVER_TOPIC_ID,
      fullHistoryReceipts: Array.isArray(fullHistoryReceipts) ? fullHistoryReceipts.length : 0,
      tenetReceipts: Array.isArray(options.package.tenetReaffirmationReceipts) ? options.package.tenetReaffirmationReceipts.length : 0,
      storePath: store.path,
      storeMessages: store.messages.size,
    },
    corpusMismatches: surfacedMismatches,
  };
}

export function requiredBetweenWindowCorpusMismatches(): CorpusMismatch[] {
  return REQUIRED_MISMATCHES.map((m) => ({
    scope: m.scope,
    observer1: { ...m.observer1 },
    observer2: { ...m.observer2 },
  }));
}
