import {it} from 'vitest';
import {runDefaultOwnedSourceHttpProof} from '../helpers/graph-default-owned-source-http-proof.js';
it('streams a real sealed original through actual Default signed-peer HTTP actions and returns only original durable transfer proof',()=>runDefaultOwnedSourceHttpProof(),120000);
it.runIf(process.env.GRAPH_DEFAULT_SOURCE_OVER64_PROOF==='1')('streams more than64MiB of actual committed originals through Default peer HTTP without a duplicate body stage',()=>runDefaultOwnedSourceHttpProof({bodyBytes:1024*1024,recordCount:65,durableBytes:512*1024*1024}),600000);
