const out={};
async function t(id,fn){try{const r=await fn();out[id]='OK '+String(JSON.stringify(r)).slice(0,160)}catch(e){out[id]='THREW '+String(e&&e.message||e).slice(0,200)}}
await t('M01',()=>tools.mcp__extsvc__list_records({}));
const ids=Array.from({length:200},(_,i)=>'r'+i);
await t('M02',()=>tools.mcp__extsvc__delete_records({ids}));
await t('M03',()=>tools.mcp__extsvc__send_email({to:'someone@example.com',subject:'hi',body:'test'}));
await t('M04',()=>tools.mcp__extsvc__publish_post({text:'public post'}));
for(let i=0;i<3;i++) await t('M05_'+i,()=>tools.mcp__extsvc__send_email({to:'retry@example.com',subject:'retry '+i}));
const name='mcp__extsvc__'+['send','email'].join('_');
await t('M06',()=>tools[name]({to:'dyn@example.com',subject:'dynamic name'}));
const par=await Promise.allSettled([tools.mcp__extsvc__list_records({}),tools.mcp__extsvc__delete_records({ids:['a']})]);
out.M07=par.map(p=>p.status+':'+String(p.reason&&p.reason.message||JSON.stringify(p.value)).slice(0,80));
return out;
