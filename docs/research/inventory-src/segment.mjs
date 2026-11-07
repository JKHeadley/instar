import fs from 'fs';
const src = fs.readFileSync(process.argv[2],'utf8');
const lines = src.split('\n');
const units=[]; let cur=null; let heading=[]; let inFence=false;
function start(i,title,kind){ cur={startLine:i+1,title,kind,headingPath:heading.join(' > '),lines:[]}; units.push(cur); }
for(let i=0;i<lines.length;i++){
  const l=lines[i]; const prev=i>0?lines[i-1]:'';
  if(l.startsWith('```')) inFence=!inFence;
  const h=!inFence && /^(#{1,4}) (.*)$/.exec(l);
  if(h){ const lvl=h[1].length; heading=heading.slice(0,lvl-1); heading[lvl-1]=h[2].trim(); start(i,h[2].trim(),'heading'); }
  else if(!inFence && prev.trim()==='' && (/^\*\*[^*]/.test(l) || /^- \*\*[^*]/.test(l))){
    const m=/\*\*(.+?)\*\*/.exec(l); start(i,(m?m[1]:l.slice(0,60)).replace(/[:.]$/,'').trim(),'bold');
  } else if(!cur) start(i,'(preamble)','pre');
  cur.lines.push(l);
}
const out=units.map((u,k)=>{const text=u.lines.join('\n'); return {id:'B'+String(k+1).padStart(3,'0'),startLine:u.startLine,endLine:u.startLine+u.lines.length-1,title:u.title,headingPath:u.headingPath,chars:text.length,tokensEst:Math.ceil(text.length/4),text};}).filter(u=>u.text.trim().length>0);
fs.writeFileSync(process.argv[3],JSON.stringify(out,null,1));
console.log(out.length, out.reduce((a,u)=>a+u.chars,0));
