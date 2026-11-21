// Test guards (instrument). mode = argv[2].
const fs=require('fs');const mode=process.argv[2];let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
 let e={};try{e=JSON.parse(d)}catch{}
 const ti=e.tool_input||{};const cmd=String(ti.command||'');const fp=String(ti.file_path||ti.notebook_path||'');
 const log=(m)=>fs.appendFileSync('/private/tmp/claude-501/cmx-lab/guards.log',new Date().toISOString()+' '+mode+' '+m+'\n');
 if(mode==='protected'){ if(fp.includes('/lab/protected/')){log('BLOCK '+fp);process.stderr.write('BLOCKED by protected-path guard: '+fp+'\n');process.exit(2);} process.exit(0);}
 if(mode==='slow'){ if(cmd.includes('SLOWGUARD_MARK')){log('start');setTimeout(()=>{log('BLOCK');process.stderr.write('BLOCKED by slow guard after 8s\n');process.exit(2)},8000);return;} process.exit(0);}
 if(mode==='slowtimeout'){ if(cmd.includes('SLOWTIMEOUT_MARK')){log('start');setTimeout(()=>{log('BLOCK(late)');process.stderr.write('BLOCKED by slow guard after 15s\n');process.exit(2)},15000);return;} process.exit(0);}
 if(mode==='fail'){ if(cmd.includes('FAILGUARD_MARK')){log('crash');process.stderr.write('guard crashed: simulated internal error\n');process.exit(1);} process.exit(0);}
 if(mode==='failblock'){ if(cmd.includes('FAILBLOCK_MARK')){log('crash');process.stderr.write('guard crashed: simulated internal error\n');process.exit(1);} process.exit(0);}
 process.exit(0);});
