/** Opt-in native administration barrier. Ordinary lease persistence is unchanged. */
import fs from 'node:fs';import path from 'node:path';
import {durableStamp,isDurablyUnchanged,rememberDurable} from './GraphDurableFileMemo.js';
import type {LeaseRecord} from './types.js';
export function syncNativeLeaseFile(file:string,expected:LeaseRecord|null,readLease:(document:unknown)=>unknown):void{
 const flushed=isDurablyUnchanged(file),stamp=durableStamp(file),before=fs.lstatSync(file),descriptor=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{const actual=fs.fstatSync(descriptor);if(before.isSymbolicLink()||!actual.isFile()||actual.ino!==before.ino||actual.dev!==before.dev)throw new Error('native-lease-durability-file-changed');if(!flushed)fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
 if(!flushed)for(let directory=path.dirname(file);;directory=path.dirname(directory)){const handle=fs.openSync(directory,'r');try{fs.fsyncSync(handle);}finally{fs.closeSync(handle);}if(path.dirname(directory)===directory)break;}
 const after=fs.lstatSync(file);if(after.ino!==before.ino||after.dev!==before.dev||JSON.stringify(readLease(JSON.parse(fs.readFileSync(file,'utf8'))))!==JSON.stringify(expected))throw new Error('native-lease-durability-readback-mismatch');
 if(!flushed)rememberDurable(file,stamp);
}
