import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Router, Request, Response } from 'express';
import { RuleResponseLedger } from '../messaging/RuleResponseLedger.js';

function inspectDraft(body: { draft?: unknown; hasAsk?: unknown }) {
  if (typeof body.draft !== 'string' || !body.draft.trim() || body.draft.length > 16_000
    || typeof body.hasAsk !== 'boolean') throw new Error('draft and ask classification are required');
  const lines = body.draft.split(/\r?\n/);
  const heading = lines.findIndex(line => /^\s*[*#_ ]*what i need from you[*_ :]*$/i.test(line));
  const section = heading < 0 ? [] : lines.slice(heading + 1);
  const nextHeading = section.findIndex(line => /^\s*#{1,6}\s/.test(line));
  const asks = (nextHeading < 0 ? section : section.slice(0, nextHeading)).filter(line => line.trim());
  const lacksLinks = body.hasAsk && (!asks.length || asks.some(line => !/https?:\/\/[^\s<>()]+/i.test(line)));
  return { digest: createHash('sha256').update(body.draft).digest('hex'), lacksLinks };
}

export function registerRuleResponseRoutes(router: Router, options: {
  stateDir: string;
  enabled: () => boolean;
  isDeliveredAgentReply: (topic: number, message: number) => boolean;
}): void {
  function handle(req: Request, res: Response, operation: (ledger: RuleResponseLedger) => unknown): void {
    if (!options.enabled()) {
      res.status(404).json({ error: 'rule response trial disabled' });
      return;
    }
    if (req.get('X-Instar-Request') !== '1') {
      res.status(403).json({ error: 'rule response requires an intent header' });
      return;
    }
    if (req.body?.rule !== 'ask-links') {
      res.status(400).json({ error: 'unsupported trial rule' });
      return;
    }
    let ledger: RuleResponseLedger | undefined;
    try {
      ledger = new RuleResponseLedger(path.join(options.stateDir, 'rule-responses.db'));
      res.json(operation(ledger));
    } catch {
      // Report a bounded response instead of returning source paths or stored reasons.
      res.status(409).json({ error: 'rule response could not be recorded or read' });
    } finally {
      ledger?.close();
    }
  }

  router.post('/rule-responses/finding', (req, res) => handle(req, res, ledger => {
    const { rule, topic, message, confirmed } = req.body;
    if (typeof confirmed !== 'boolean' || (confirmed && !options.isDeliveredAgentReply(topic, message))) {
      throw new Error('confirmed finding requires a sent reply');
    }
    return ledger.recordFinding({ rule, topic, message, confirmed });
  }));
  router.post('/rule-responses/draft', (req, res) => handle(req, res, ledger => {
    const { rule, topic } = req.body;
    const { digest, lacksLinks } = inspectDraft(req.body);
    const response = ledger.draftResponse(rule, topic, digest);
    const draftCheck = response.action !== 'draft-check' ? 'not-required'
      : response.overrideReason ? 'overridden' : lacksLinks ? 'needs-links' : 'pass';
    return { ...response, digest, draftCheck };
  }));
  router.post('/rule-responses/override', (req, res) => handle(req, res, ledger => {
    const { rule, topic, reason } = req.body;
    const { digest, lacksLinks } = inspectDraft(req.body);
    if (!lacksLinks) throw new Error('draft must have a finding to override');
    return { ...ledger.recordOverride(rule, topic, digest, reason), digest, draftCheck: 'overridden' };
  }));
}
