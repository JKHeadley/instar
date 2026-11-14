/** Managed witness ingress, not an owner dashboard API. Per-agent credentials
 * authenticate transport; signed membership, native lease and receipts govern writes.
 */
import { Router, type Request, type Response } from 'express';
import {graphWitnessEndpoints} from '../core/GraphWitnessDispatcher.js';
import { GraphWitnessError, type GraphWitnessService } from '../core/GraphWitnessService.js';

export function createGraphWitnessRoutes(service: GraphWitnessService): Router {
  const router = Router();
  router.get('/health', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(service.health()); });
  router.use('/v1/agents/:agentId', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!service.authenticate(req.params.agentId, token)) { res.status(401).json({ code: 'witness-auth-required' }); return; }
    next();
  });
  const execute = (fn: (req: Request) => unknown) => (req: Request, res: Response) => {
    try { res.json(fn(req)); }
    catch (error) {
      if (error instanceof GraphWitnessError) res.status(error.status).json({ code: error.code });
      else res.status(400).json({ code: 'witness-request-invalid' });
    }
  };
  for(const endpoint of graphWitnessEndpoints(service)){
    const handler=execute(req=>endpoint.handle({params:req.params as Record<string,string>,query:req.query as Record<string,string|undefined>,body:req.body}));
    if(endpoint.method==='GET')router.get(endpoint.path,handler);else router.post(endpoint.path,handler);
  }
  return router;
}
