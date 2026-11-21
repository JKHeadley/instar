const EFF='/private/tmp/claude-501/cmx-lab/effects.log'; const out={};
async function sh(id,cmd){const t0=Date.now();try{const r=await $(cmd).nothrow();let s;try{s=JSON.stringify(r)}catch{s=String(r)}out[id]=(Date.now()-t0)+'ms '+(s||String(r)).slice(0,180)}catch(e){out[id]=(Date.now()-t0)+'ms THREW '+String(e&&e.message||e).slice(0,180)}}
await sh('G01','echo SLOWGUARD_MARK; echo G01 >> '+EFF);
await sh('G02','echo SLOWTIMEOUT_MARK; echo G02 >> '+EFF);
await sh('G03','echo FAILGUARD_MARK; echo G03 >> '+EFF);
await sh('G04','echo FAILBLOCK_MARK; echo G04 >> '+EFF);
const t0=Date.now();
const par=await Promise.allSettled([$('echo SLOWGUARD_MARK; echo G05 >> '+EFF).nothrow(),$('echo G05ctl >> '+EFF).nothrow()]);
out.G05=(Date.now()-t0)+'ms '+par.map(p=>p.status).join(',');
return out;
