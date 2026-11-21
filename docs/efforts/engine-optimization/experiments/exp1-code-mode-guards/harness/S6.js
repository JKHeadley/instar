// Recording stress: many fast calls, sequential and parallel, to see if any event goes unrecorded.
const out={seq:0,par:0,mcp:0};
for(let i=0;i<20;i++){await $('echo seq'+i).nothrow();out.seq++;}
const ps=[];for(let i=0;i<10;i++)ps.push($('echo par'+i).nothrow());
await Promise.allSettled(ps);out.par=10;
const ms=[];for(let i=0;i<10;i++)ms.push(tools.mcp__extsvc__list_records({}));
const r=await Promise.allSettled(ms);out.mcp=r.filter(x=>x.status==='fulfilled').length;
for(let i=0;i<5;i++){await write('lab/stress'+i+'.txt','s'+i);}
out.writes=5;
return out;
