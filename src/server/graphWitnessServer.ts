/** Production composition for the separately deployed, persistent witness. */
import express from 'express';
import { GraphWitnessService, type GraphWitnessServiceOptions } from '../core/GraphWitnessService.js';
import { createGraphWitnessRoutes } from './graphWitnessRoutes.js';

export function createGraphWitnessServer(options: GraphWitnessServiceOptions): { app: express.Express; service: GraphWitnessService } {
  const service = new GraphWitnessService(options);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '3mb', strict: true }));
  app.use(createGraphWitnessRoutes(service));
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ code: 'witness-request-invalid' });
  });
  return { app, service };
}
