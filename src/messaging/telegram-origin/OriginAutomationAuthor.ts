import { createHash, randomUUID } from 'node:crypto';
import type { IntelligenceOptions } from '../../core/types.js';
import type { OriginEvidence } from './types.js';

export interface OriginAutomationAuthor {
  model: OriginEvidence; harness: OriginEvidence;
  authorContributors?: Array<{ model: OriginEvidence; harness: OriginEvidence }>;
  omittedAuthorContributors?: number;
}

/** Keep the author calls whose words survived aggregation. Mixed evidence is
 * explicit; the last caller never becomes the author of the whole batch. */
export function composeAutomationAuthors(authors: OriginAutomationAuthor[]): OriginAutomationAuthor {
  if (!authors.length) return unknownAutomationAuthor('aggregate-author-evidence-missing');
  if (authors.length === 1) return structuredClone(authors[0]);
  const all = authors.flatMap(author => author.authorContributors ?? [{ model: author.model, harness: author.harness }]);
  const distinct = [...new Map(all.map(author => [JSON.stringify(author), author])).values()];
  const omitted = Math.max(0, distinct.length - 128) + authors.reduce((n, author) => n + (author.omittedAuthorContributors ?? 0), 0);
  const contributors = structuredClone(distinct.slice(0, 128));
  const sourceEventRef = `author-composition:${createHash('sha256').update(JSON.stringify(contributors)).digest('hex')}`;
  const merge = (field: 'model' | 'harness'): OriginEvidence => {
    const values = all.map(author => author[field]);
    if (!omitted && values.every(value => value.status === 'not-applicable')) return deterministicAutomationAuthor()[field];
    if (!omitted && values.every(value => value.value != null && value.value === values[0].value && ['observed', 'configured'].includes(value.status))) {
      return { value: values[0].value, status: values.every(value => value.status === 'observed') ? 'observed' : 'configured',
        sourceEventRef, observedAt: Math.max(...values.map(value => value.observedAt ?? 0)) || null, reason: 'composed-author-evidence' };
    }
    return { ...unknownAutomationAuthor(omitted ? 'aggregate-author-bound-exceeded' : 'multiple-or-unknown-author-calls')[field], sourceEventRef };
  };
  return { model: merge('model'), harness: merge('harness'), authorContributors: contributors,
    ...(omitted ? { omittedAuthorContributors: omitted } : {}) };
}
export function unknownAutomationAuthor(reason = 'unbound-author-call'): OriginAutomationAuthor {
  const evidence: OriginEvidence = { value: null, status: 'unknown', sourceEventRef: null, observedAt: null, reason };
  return { model: { ...evidence }, harness: { ...evidence } };
}
export function deterministicAutomationAuthor(): OriginAutomationAuthor {
  const evidence: OriginEvidence = { value: null, status: 'not-applicable', sourceEventRef: null,
    observedAt: null, reason: 'deterministic-automation' };
  return { model: { ...evidence }, harness: { ...evidence } };
}
/** A per-invocation capture, passed only to the call that authors the text.
 * onModel reports the resolved configuration; it is not a native turn event.
 * A fallback provider may replace the selection before the call completes.
 * Delivery validators never receive this capture and cannot become the author.
 */
export class OriginAuthorCall {
  readonly callId = `author-call:${randomUUID()}`;
  private author = unknownAutomationAuthor('author-provider-model-unavailable');
  options(input: IntelligenceOptions): IntelligenceOptions {
    return { ...input, onModel: info => {
      const at = Date.now();
      const valid = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
        value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
      // The interactive pool reports its lane, not the actual model.
      this.author = {
        model: valid(info.model) && info.model !== 'interactive-pool'
          ? { value: info.model, status: 'configured', sourceEventRef: this.callId, observedAt: at, reason: 'resolved-author-call-config' }
          : { ...unknownAutomationAuthor('author-provider-model-unavailable').model, sourceEventRef: this.callId },
        harness: valid(info.framework)
          ? { value: info.framework, status: 'configured', sourceEventRef: this.callId, observedAt: at, reason: 'resolved-author-call-config' }
          : { ...unknownAutomationAuthor('author-provider-framework-unavailable').harness, sourceEventRef: this.callId },
      };
      input.onModel?.(info);
    } };
  }
  snapshot(): OriginAutomationAuthor { return structuredClone(this.author); }
}
