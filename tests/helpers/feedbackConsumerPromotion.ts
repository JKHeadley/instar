import request from 'supertest';
import type { Express } from 'express';

/**
 * Promote the feedback consumer the way an operator now must: run simulation
 * drain ticks until the server proposes a batch, then promote with that exact
 * proposalSetHash and bound. Returns the proposal and the promote response.
 */
export async function promoteConsumerFromProposal(app: Express, opts: {
  auth: string;
  pin: string;
  agentId: string;
  operatorDecisionId: string;
  noncePrefix: string;
  maxTicks?: number;
}): Promise<{ proposal: Record<string, unknown>; promote: request.Response }> {
  const H = { Authorization: `Bearer ${opts.auth}` };
  const HX = { ...H, 'X-Instar-Request': '1' };
  let proposal = (await request(app).get('/feedback-factory/consumer/promotion/proposal').set(H)).body as Record<string, unknown>;
  for (let tick = 0; tick < (opts.maxTicks ?? 5) && proposal.state !== 'pending'; tick++) {
    const nonce = `${opts.noncePrefix}-${String(tick).padStart(4, '0')}`;
    const started = await request(app).post('/feedback-factory/drain/tick')
      .set({ ...HX, 'X-Instar-AgentId': opts.agentId, 'X-Instar-Request-Nonce': nonce });
    if (started.status === 202) {
      const runId = started.body.runId as string;
      for (let attempt = 0; attempt < 300; attempt++) {
        const last = (await request(app).get('/feedback-factory/drain/status').set(H)).body?.lastRun;
        if (last?.runId === runId && last.state !== 'accepted' && last.state !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    proposal = (await request(app).get('/feedback-factory/consumer/promotion/proposal').set(H)).body as Record<string, unknown>;
  }
  const promote = await request(app).post('/feedback-factory/consumer/promote').set(HX).send({
    pin: opts.pin,
    approvedBatchBound: proposal.approvedBatchBound,
    evidenceHash: proposal.proposalSetHash,
    operatorDecisionId: opts.operatorDecisionId,
  });
  return { proposal, promote };
}
