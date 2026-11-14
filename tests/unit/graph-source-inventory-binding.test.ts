import {describe,expect,it} from 'vitest';
import {GraphSourceInventoryBinding} from '../../src/server/GraphSourceInventoryBinding.js';
const settle=async()=>{for(let n=0;n<8;n++)await new Promise(resolve=>setImmediate(resolve));};
function rig(){
 const log:string[]=[];
 const worker=(name:string,closing?:Promise<void>)=>({start(){log.push(`start ${name}`);},async close(){log.push(`closing ${name}`);await closing;log.push(`closed ${name}`);}});
 return {log,worker,binding:new GraphSourceInventoryBinding<{name:string},ReturnType<typeof worker>>()};
}
describe('GraphSourceInventoryBinding',()=>{
 it('moves the worker to a replacement runtime, the way a removal needs',async()=>{
  const {log,worker,binding}=rig(),first={name:'first'},second={name:'second'},failures:unknown[]=[];
  binding.use(first,async runtime=>worker(runtime.name),error=>failures.push(error));await settle();
  binding.use(second,async runtime=>worker(runtime.name),error=>failures.push(error));await settle();
  expect(log).toEqual(['start first','closing first','closed first','start second']);expect(failures).toEqual([]);
 });
 it('leaves a running worker alone when asked for the same runtime again',async()=>{
  const {log,worker,binding}=rig(),only={name:'only'};let created=0;
  const create=async(runtime:{name:string})=>{created++;return worker(runtime.name);};
  binding.use(only,create,()=>{});binding.use(only,create,()=>{});await settle();binding.use(only,create,()=>{});await settle();
  expect(created).toBe(1);expect(log).toEqual(['start only']);
 });
 it('never starts the replacement until the old worker has finished',async()=>{
  const {log,worker,binding}=rig(),first={name:'first'},second={name:'second'};let release=()=>{};const closing=new Promise<void>(resolve=>{release=resolve;});
  binding.use(first,async runtime=>worker(runtime.name,closing),()=>{});await settle();
  binding.use(second,async runtime=>worker(runtime.name),()=>{});await settle();
  expect(log).toEqual(['start first','closing first']);
  release();await settle();expect(log).toEqual(['start first','closing first','closed first','start second']);
 });
 it('uses only the newest runtime when one is replaced while still opening',async()=>{
  const {log,worker,binding}=rig(),first={name:'first'},second={name:'second'};let release=()=>{};const held=new Promise<void>(resolve=>{release=resolve;});
  binding.use(first,async runtime=>{await held;return worker(runtime.name);},()=>{});await settle();
  binding.use(second,async runtime=>worker(runtime.name),()=>{});release();await settle();
  expect(log).toEqual(['closing first','closed first','start second']);
 });
 it('starts nothing after close and closes what it holds',async()=>{
  const {log,worker,binding}=rig(),first={name:'first'},second={name:'second'};
  binding.use(first,async runtime=>worker(runtime.name),()=>{});await settle();await binding.close();
  binding.use(second,async runtime=>worker(runtime.name),()=>{});await settle();
  expect(log).toEqual(['start first','closing first','closed first']);
 });
 it('reports a worker that could not open, and a later runtime still gets one',async()=>{
  const {log,worker,binding}=rig(),first={name:'first'},second={name:'second'},failures:unknown[]=[];
  binding.use(first,async()=>{throw new Error('no worker');},error=>failures.push(error));await settle();
  expect((failures[0] as Error).message).toBe('no worker');
  binding.use(second,async runtime=>worker(runtime.name),error=>failures.push(error));await settle();
  expect(log).toEqual(['start second']);expect(failures).toHaveLength(1);
 });
});
