/** Qualify the host sshd boundary before granting a restricted recovery key.
 * AcceptEnv is applied before the user's shell/forced command starts; cleaning
 * Node's environment in the wrapper cannot fix an unsafe shell startup policy.
 * https://man.openbsd.org/sshd_config#AcceptEnv
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {withSyncOp} from '../core/InFlightSyncOpMarker.js';

const safeEnvironment=(value:string)=>value==='LANG'||value==='LC_*'||/^LC_[A-Z0-9_]+$/.test(value);
/** The daemon's own parser is authoritative; static scanning also refuses Match
 * contexts we cannot qualify for every possible route/source address. */
export function validateRecoverySshEnvironment(output:string):void {
  if(typeof output!=='string'||Buffer.byteLength(output)>262144)throw new Error('recovery-ssh-environment-policy-unknown');
  const rows=output.split(/\r?\n/).map(line=>line.trim().split(/\s+/)).filter(parts=>parts[0]);
  const userEnv=rows.filter(parts=>parts[0]==='permituserenvironment');
  const forced=rows.filter(parts=>parts[0]==='forcecommand');
  if(userEnv.length!==1||userEnv[0].length!==2||userEnv[0][1]!=='no'||forced.length!==1||forced[0].length!==2||forced[0][1]!=='none'
    ||rows.filter(parts=>parts[0]==='acceptenv').some(parts=>parts.slice(1).some(value=>!safeEnvironment(value)))
    ||rows.filter(parts=>parts[0]==='setenv').some(parts=>parts.slice(1).some(value=>!value.includes('=')||!safeEnvironment(value.split('=',1)[0]))))throw new Error('recovery-ssh-environment-policy-unsafe');
}
export function qualifyRecoverySshEnvironment(input:{hostKeyFile:string;configFile?:string;run?:(args:string[])=>string}):{digest:string} {
  const configFile=input.configFile??'/etc/ssh/sshd_config',files=new Map<string,string>();let bytes=0;
  const key=fs.lstatSync(input.hostKeyFile);
  if(!path.isAbsolute(input.hostKeyFile)||!key.isFile()||key.isSymbolicLink()||key.uid!==process.getuid?.()||(key.mode&0o077)||key.size>16384)throw new Error('recovery-ssh-environment-policy-unknown');
  const read=(file:string):void=>{
    file=path.resolve(file);
    if(files.has(file)||files.size>=64)throw new Error('recovery-ssh-environment-policy-unknown');
    const directory=fs.lstatSync(path.dirname(file));
    if(!directory.isDirectory()||directory.isSymbolicLink()||(directory.uid!==0&&directory.uid!==process.getuid?.())||(directory.mode&0o022))throw new Error('recovery-ssh-environment-policy-unknown');
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let text:string;
    try{const st=fs.fstatSync(fd);if(!st.isFile()||(st.uid!==0&&st.uid!==process.getuid?.())||(st.mode&0o022)||st.size>262144)throw new Error('recovery-ssh-environment-policy-unknown');bytes+=st.size;if(bytes>1048576)throw new Error('recovery-ssh-environment-policy-unknown');text=fs.readFileSync(fd,'utf8');}finally{fs.closeSync(fd);}
    files.set(file,text!);
    for(const line of text!.split(/\r?\n/)){
      const parts=line.replace(/#.*/,'').trim().split(/\s+/),directive=parts[0].toLowerCase();
      if(directive==='match')throw new Error('recovery-ssh-environment-policy-unqualified-match');
      if(directive==='acceptenv'&&parts.slice(1).some(value=>!safeEnvironment(value)))throw new Error('recovery-ssh-environment-policy-unsafe');
      if(directive==='setenv'&&parts.slice(1).some(value=>!value.includes('=')||!safeEnvironment(value.split('=',1)[0])))throw new Error('recovery-ssh-environment-policy-unsafe');
      if(directive==='permituserenvironment'&&(parts.length!==2||parts[1].toLowerCase()!=='no'))throw new Error('recovery-ssh-environment-policy-unsafe');
      if(directive==='forcecommand'&&(parts.length!==2||parts[1].toLowerCase()!=='none'))throw new Error('recovery-ssh-environment-policy-unsafe');
      if(directive!=='include')continue;
      if(parts.length<2)throw new Error('recovery-ssh-environment-policy-unknown');
      for(const pattern of parts.slice(1)){
        if(!path.isAbsolute(pattern)||/[\[\]{}%~"'\\]/.test(pattern)||/[*?]/.test(path.dirname(pattern)))throw new Error('recovery-ssh-environment-policy-unknown');
        if(!/[*?]/.test(pattern)){if(fs.existsSync(pattern))read(pattern);continue;}
        let names:string[];try{names=fs.readdirSync(path.dirname(pattern));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
        const expression=new RegExp('^'+path.basename(pattern).split('').map(c=>c==='*'?'.*':c==='?'?'.':c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('')+'$');
        const matching=names.filter(name=>expression.test(name)).sort();if(matching.length>64)throw new Error('recovery-ssh-environment-policy-unknown');
        for(const name of matching)read(path.join(path.dirname(pattern),name));
      }
    }
  };
  try{
    read(configFile);
    const args=['-T','-f',configFile,'-h',input.hostKeyFile];
    const output=input.run?input.run(args):withSyncOp(()=>execFileSync('/usr/sbin/sshd',args,{encoding:'utf8',timeout:5000,maxBuffer:262144,stdio:['ignore','pipe','pipe']}));
    validateRecoverySshEnvironment(output);
    return {digest:crypto.createHash('sha256').update(JSON.stringify([...files.entries()].sort())).update(output).digest('hex')};
  }catch(error){if(error instanceof Error&&/^recovery-[a-z-]+$/.test(error.message))throw error;throw new Error('recovery-ssh-environment-policy-unknown');}
}
