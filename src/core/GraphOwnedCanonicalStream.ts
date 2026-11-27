/** Canonical serialization of source-backed arrays. Data framing only: an
 * iterable is never proof of source custody, owner consent, or membership. */
import crypto from 'node:crypto';
import {canonicalJson} from './GraphWitnessTypes.js';
export class GraphCanonicalArrayStream {
 constructor(readonly values:AsyncIterable<unknown>){}
}
export async function* graphCanonicalTokens(value:unknown):AsyncGenerator<string>{
 if(value instanceof GraphCanonicalArrayStream){yield '[';let first=true;for await(const child of value.values){if(!first)yield ',';first=false;yield*graphCanonicalTokens(child);}yield ']';return;}
 if(Array.isArray(value)){yield '[';for(let index=0;index<value.length;index++){if(index)yield ',';yield*graphCanonicalTokens(value[index]);}yield ']';return;}
 if(value&&typeof value==='object'){yield '{';let first=true;for(const key of Object.keys(value).sort()){const child=(value as Record<string,unknown>)[key];if(child===undefined)continue;if(!first)yield ',';first=false;yield JSON.stringify(key);yield ':';yield*graphCanonicalTokens(child);}yield '}';return;}
 yield canonicalJson(value);
}
/** Hashes exactly the legacy canonicalJson byte sequence without joining a
 * whole history. A scalar is bounded by its own original schema domain. */
export async function graphCanonicalStreamHash(value:unknown):Promise<{hash:string;bytes:number}>{
 const digest=crypto.createHash('sha256');let bytes=0;for await(const token of graphCanonicalTokens(value)){const size=Buffer.byteLength(token);if(!Number.isSafeInteger(bytes+size))throw new Error('graph-canonical-stream-byte-overflow');bytes+=size;digest.update(token);}return{hash:digest.digest('hex'),bytes};
}
