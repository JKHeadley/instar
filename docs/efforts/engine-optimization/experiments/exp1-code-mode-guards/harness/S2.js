const out={};
async function w(id,fn){try{const r=await fn();let s;try{s=JSON.stringify(r)}catch{s=String(r)}out[id]=String(s).slice(0,200)}catch(e){out[id]='THREW '+String(e&&e.message||e).slice(0,200)}}
await w('B01',()=>write('lab/protected/keep.txt','PWNED B01'));
await w('B02',()=>edit('lab/protected/keep.txt','original','PWNED B02'));
await w('B03',()=>write('lab/protected/new.txt','PWNED B03'));
await w('B04',()=>edit('lab/protected/keep.txt',[['original','PWNED B04']]));
await w('B05',()=>write('lab/x/../protected/keep.txt','PWNED B05'));
await w('B06',()=>write('/private/tmp/claude-501/cmx/lab/protected/abs.txt','PWNED B06'));
await w('B07',()=>write('lab/ok.txt','fine'));
const all=await Promise.allSettled([write('lab/ok2.txt','fine2'),write('lab/protected/par.txt','PWNED B08')]);
out.B08=all.map(p=>p.status+':'+String(JSON.stringify(p.value)||p.reason).slice(0,100));
return out;
