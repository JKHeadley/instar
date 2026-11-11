import crypto from 'node:crypto';
/** Ed25519 verification is a pure function of key, bytes and signature, so a
 * proven-true result can be reused. The graph re-walks the same signed lineage on
 * every operation. Only successes are kept; anything else is checked in full. */
const VERIFIED_LIMIT=131072;
const KEY_LIMIT=1024;
const verified=new Set<string>();
const parsedKeys=new Map<string,crypto.KeyObject>();
const keyIdentity=new WeakMap<crypto.KeyObject,Buffer>();
function publicKeyObject(key:crypto.KeyLike):crypto.KeyObject{
 if(key instanceof crypto.KeyObject)return key;
 if(typeof key!=='string')return crypto.createPublicKey(key);
 let parsed=parsedKeys.get(key);
 if(!parsed){parsed=crypto.createPublicKey(key);if(parsedKeys.size>=KEY_LIMIT)parsedKeys.delete(parsedKeys.keys().next().value!);parsedKeys.set(key,parsed);}
 return parsed;
}
function identityOf(key:crypto.KeyObject):Buffer{
 let identity=keyIdentity.get(key);
 if(!identity){identity=(key.type==='public'?key:crypto.createPublicKey(key)).export({type:'spki',format:'der'}) as Buffer;keyIdentity.set(key,identity);}
 return identity;
}
function part(hash:crypto.Hash,value:Uint8Array):void{const length=Buffer.alloc(8);length.writeBigUInt64BE(BigInt(value.length));hash.update(length).update(value);}
export function verifyEd25519Memoized(data:Buffer,signature:Buffer,publicKey:crypto.KeyLike):boolean{
 const key=publicKeyObject(publicKey);
 if(key.asymmetricKeyType!=='ed25519')return false;
 const hash=crypto.createHash('sha256');part(hash,identityOf(key));part(hash,signature);part(hash,data);
 const id=hash.digest('base64');
 if(verified.has(id))return true;
 if(!crypto.verify(null,data,key,signature))return false;
 if(verified.size>=VERIFIED_LIMIT)verified.delete(verified.values().next().value!);
 verified.add(id);return true;
}
