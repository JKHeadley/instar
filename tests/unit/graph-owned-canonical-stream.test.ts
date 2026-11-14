import {expect,it} from 'vitest';
import {canonicalHash,canonicalJson} from '../../src/core/GraphWitnessTypes.js';
import {GraphCanonicalArrayStream,graphCanonicalStreamHash} from '../../src/core/GraphOwnedCanonicalStream.js';
it('preserves exact canonical bytes and semantic hashes for streamed records, Unicode and escaped names',async()=>{
 const records=[{z:'Unicode café / slash \n 🦉',b:[true,null,1.5,-0],a:{absent:undefined,y:'\\"'}},{id:'second',version:2}],read=async function*(){for(const record of records)yield record;};
 const actual={kind:'stage',sourceStage:{records:new GraphCanonicalArrayStream(read()),authorization:{signature:'opaque'},rewraps:[]}},original={kind:'stage',sourceStage:{records,authorization:{signature:'opaque'},rewraps:[]}};
 expect(await graphCanonicalStreamHash(actual)).toEqual({hash:canonicalHash(original),bytes:Buffer.byteLength(canonicalJson(original))});
});
it('consumes a large sequence one record at a time and propagates source-fence failures',async()=>{
 let live=0,peak=0;const rows=async function*(){for(let index=0;index<4000;index++){live++;peak=Math.max(peak,live);yield {id:index,opaque:'x'.repeat(9000)};live--;}};
 const result=await graphCanonicalStreamHash({records:new GraphCanonicalArrayStream(rows())});expect(result.bytes).toBeGreaterThan(32*1024*1024);expect(peak).toBe(1);expect(live).toBe(0);
 const refused=async function*(){yield {id:1};throw new Error('actual-reader-fence-changed');};await expect(graphCanonicalStreamHash(new GraphCanonicalArrayStream(refused()))).rejects.toThrow('actual-reader-fence-changed');
});
