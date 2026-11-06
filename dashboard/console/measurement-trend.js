// Numeric observations remain separate from improvement judgements.
import { el, askLink } from './ui.js';
import { humanName } from './maturation-board-model.js';
const SVG='http://www.w3.org/2000/svg';
const words={verified:'Recorded and corroborated',unavailable:'Cannot be read',mismatch:'Does not match the current measurement', 'foreign-origin':'Baseline belongs to another machine',future:'Dated in the future',stale:'Too old to use','before-baseline':'Earlier than the baseline','insufficient-samples':'Too few samples'};
const number=n=>typeof n==='number'&&Number.isFinite(n)?(n!==0&&(Math.abs(n)>1e7||Math.abs(n)<1e-5)?n.toExponential(5):new Intl.NumberFormat(undefined,{maximumSignificantDigits:6}).format(n)):'Unknown';
const date=n=>typeof n==='number'?new Date(n).toLocaleString():'Unknown';
const svg=(tag,attrs={},text)=>{const node=document.createElementNS(SVG,tag);for(const [k,v]of Object.entries(attrs))node.setAttribute(k,String(v));if(text!==undefined)node.textContent=text;return node;};
function retainedMethods(detail){
  const versions=detail.contractVersions;
  if(!versions?.available)return el('p',{text:detail.historicalContractDetails==='archived'?'Archived method definitions cannot be read.':'Previous contract details are not retained. Older versions remain separate; no historical method is reconstructed.'});
  const section=el('section',{},el('p',{text:`Archived definitions: ${versions.rows.length}. Not archived: ${versions.missing.length}. Outside this bounded read: ${versions.omitted.length}. Unreadable: ${versions.unreadable.length}.`}));
  for(const version of versions.rows){
    const c=version.contract;
    section.append(el('details',{},el('summary',{text:`${version.hash===detail.currentContractHash?'Current definition':'Historical definition'} — ${c.outcome?.version||'method version not recorded'}`}),
      el('p',{text:c.outcome?.statement||'Intended outcome not recorded.'}),el('p',{text:c.outcome?.method||'Method description not recorded.'}),
      el('p',{text:`Owner: ${c.outcome?.owner||'not recorded'}. Evaluation every ${c.cadenceHours} hours; evidence age limit ${c.evidenceMaxAgeHours} hours.`}),
      el('ul',{},c.metrics.map(m=>el('li',{text:`${humanName({id:m.id})}: ${m.direction==='at-least'?'at least':'at most'} ${number(m.threshold)}, minimum ${m.minSamples} samples; source ${m.sourceRef}.`}))),
      el('p',{class:'mb-hint',text:`Definition first archived ${date(version.firstArchivedAtMs)}. Last seen as current ${date(version.lastSeenAtMs)}. Identity: ${version.hash}. This archive does not establish a baseline observation or an improvement verdict.`})));
  }
  return section;
}
export function measurementChart(metric,series,detail,proof) {
  const points=series.points||[];
  if(!points.length)return el('p',{text:metric.historyAvailable?'No recorded points in this read.':'Numeric history cannot be read.'});
  const baseline=proof?.baseline?.state==='verified'&&series.source===metric.source&&series.sourceRef===metric.sourceRef&&series.descriptorVersion===proof.descriptorVersion?proof.baseline.value:null;
  const past=points.filter(p=>p.at<=Date.parse(detail.generatedAt));
  if(!past.length)return el('p',{text:'These points are dated in the future and cannot establish a trend.'});
  const values=past.map(p=>p.value);if(baseline!==null)values.push(baseline);
  const scale=Math.max(1,...values.map(Math.abs)),low=Math.min(...values)/scale,high=Math.max(...values)/scale,range=high-low||.1;
  const left=52,right=340,top=20,bottom=130,minTime=past[0].at,maxTime=past[past.length-1].at;
  const x=t=>left+(maxTime===minTime ? 0.5 : (t-minTime)/(maxTime-minTime))*(right-left);
  const y=v=>bottom-(v/scale-low+range*.1)/(range*1.2)*(bottom-top);
  const picture=svg('svg',{viewBox:'0 0 360 170',role:'img','aria-label':`${humanName({id:metric.id})}: ${past.length} recorded points; lines only where evaluation continuity is established.`});
  picture.append(svg('title',{},'Recorded numeric values. A line does not establish causation or statistical significance.'),svg('line',{x1:left,y1:bottom,x2:right,y2:bottom,stroke:'currentColor','stroke-opacity':'.4'}));
  for(const value of (low===high?[low*scale]:[low*scale,high*scale]))picture.append(svg('text',{x:4,y:y(value)+4,'font-size':11,fill:'currentColor'},number(value)));
  if(baseline!==null)picture.append(svg('line',{x1:left,y1:y(baseline),x2:right,y2:y(baseline),stroke:'currentColor','stroke-dasharray':'4 4','stroke-opacity':'.5'}));
  let previous=null;
  for(const point of points){
    if(point.at>Date.parse(detail.generatedAt)){previous=null;continue;}
    if(previous&&point.joinPrevious)picture.append(svg('line',{x1:x(previous.at),y1:y(previous.value),x2:x(point.at),y2:y(point.value),stroke:'var(--accent)','stroke-width':2}));
    const usable=point.samples>=metric.minSamples&&point.evaluation?.contractHash===detail.currentContractHash&&proof?.descriptorVersion===series.descriptorVersion&&series.source===metric.source&&series.sourceRef===metric.sourceRef;
    const dot=svg('circle',{cx:x(point.at),cy:y(point.value),r:3.5,stroke:'var(--accent)',fill:usable?'var(--accent)':'var(--bg)'});
    dot.append(svg('title',{},`${date(point.at)}: ${number(point.value)}, ${point.samples} samples${usable?'':'; evaluation or sample evidence is incomplete'}`));picture.append(dot);previous=point;
  }
  picture.append(svg('text',{x:left,y:155,'font-size':11,fill:'currentColor'},new Date(minTime).toLocaleDateString()),svg('text',{x:right,y:155,'text-anchor':'end','font-size':11,fill:'currentColor'},new Date(maxTime).toLocaleDateString()));
  const wrapper=el('figure',{class:'mb-measurement-chart'},picture,el('figcaption',{text:baseline===null?'Dots are recorded values. Gaps and separate versions are not joined.':'Dashed line: corroborated baseline. Gaps and separate versions are not joined.'}));
  const future=points.length-past.length;if(future)wrapper.append(el('p',{text:`${future} future-dated points cannot be used.`}));
  return wrapper;
}
export function measurementDetail(read) {
  if(!read||read.schema!=='measurement-read/1')return el('div',{},el('p',{text:'This machine cannot provide a supported measurement read.'}),askLink('Measurement details cannot be read.'));
  const messages={'missing-contract':'No measurement contract is recorded for this work.','invalid-contract':'The measurement contract needs repair.','unknown-subject':'This work is not known to that measurement owner.',unavailable:'The measurement owner cannot be read right now.'};
  if(read.state!=='available'||!read.detail)return el('div',{},el('p',{text:messages[read.state]||'Measurements cannot be read.'}),askLink(messages[read.state]||'Measurements cannot be read.'));
  const d=read.detail,proof=d.evidence;
  const panel=el('section',{class:'mb-measurement-detail'},el('h3',{text:'Recorded measurements'}),
    el('p',{text:proof.statement||'An intended outcome and baseline have not been recorded.'}),
    el('p',{class:'mb-hint',text:'A numerical change does not by itself prove improvement.'}),
    el('p',{class:'mb-hint',text:`Read ${new Date(d.generatedAt).toLocaleString()}. ${d.subjectKnown?'Included in the latest evaluation pass.':'Not in the latest evaluation pass; retained evidence is shown.'}`}));
  if(proof.state==='missing-contract'||proof.state==='invalid-contract')panel.append(el('p',{text:proof.state==='missing-contract'?'No corroborated outcome/baseline contract. These are raw measurements.':'The outcome/baseline declaration is invalid. Treat these as raw measurements.'}));
  const targets = new Map();
  if(proof.metrics.length)panel.append(el('nav',{'aria-label':'Outcome and quality comparisons'},proof.metrics.map(p=>el('button',{type:'button',class:'mb-link',text:`${p.qualityGuard?'Quality safeguard':'Outcome'} — ${humanName({id:p.id})}: ${p.baseline.state==='verified'?number(p.baseline.value):'unknown'} → ${p.current.state==='verified'?number(p.current.value):'unknown'}`,onclick:()=>{const target=targets.get(p.id);target?.scrollIntoView?.({block:'start'});target?.focus();}}))));
  for(const metric of d.metrics){
    const p=proof.metrics.find(m=>m.id===metric.id);
    const role=metric.outcome&&metric.qualityGuard?'Outcome and quality safeguard':metric.qualityGuard?'Quality safeguard':metric.outcome?'Outcome':'Measurement role not recorded';
    const card=el('section',{class:'mb-measurement-metric',tabindex:'-1'},el('h4',{text:humanName({id:metric.id})}),el('p',{class:'mb-hint',text:role}));
    const baseline=p?.baseline?.state==='verified'?number(p.baseline.value):words[p?.baseline?.state]||'Not recorded';
    const current=p?.current?.state==='verified'?number(p.current.value):words[p?.current?.state]||'Not usable';
    if(metric.series.length)card.append(measurementChart(metric,metric.series[0],d,p));
    else card.append(el('p',{text:metric.historyAvailable?'No numeric points were recorded in this window.':'Numeric history cannot be read.'}));
    card.append(el('p',{text:`Baseline: ${baseline}. Current: ${current}.`}),p?.comparisonAvailable?el('p',{text:`Recorded change: ${p.delta>0?'+':''}${number(p.delta)}.`}):el('p',{text:'A baseline comparison cannot be established.'}),
      el('p',{text:`Current target: ${metric.direction==='at-least'?'at least':'at most'} ${number(metric.threshold)}. At least ${metric.minSamples} samples required.`}));
    card.append(el('p',{text:p?.criterion?.met===true?'Current target reached.':p?.criterion?.met===false?'Current target not reached.':'Current target cannot be checked from corroborated evidence.'}));
    if(p?.criterion?.met===false)card.append(askLink(`The current target for ${humanName({id:metric.id})} was not reached. What should happen next?`));
    if(p)card.append(el('p',{class:'mb-hint',text:`Baseline samples: ${number(p.baseline.samples)}; current samples: ${number(p.current.samples)}. Current evidence captured: ${date(p.current.observedAtMs)}.`}));
    if(metric.series.length>1)card.append(el('details',{},el('summary',{text:`Other source/version histories (${metric.series.length-1})`}),metric.series.slice(1).map(s=>measurementChart(metric,s,d,p))));
    if(metric.omitted)card.append(el('p',{class:'mb-hint',text:`${metric.omitted} additional points are counted but not shown in this bounded read.`}));
    const values=el('details',{},el('summary',{text:'Recorded values and source details'}));
    for(const series of metric.series)values.append(el('p',{text:`${series.sourceRef}, source version ${series.descriptorVersion}`}),el('ul',{},series.points.map(point=>el('li',{text:`${date(point.at)}: ${number(point.value)}; ${point.samples} samples; ${point.evaluation?'evaluation version recorded':'evaluation version unknown'}`}))));
    card.append(values);targets.set(metric.id,card);panel.append(card);
  }
  panel.append(el('details',{},el('summary',{text:'Evaluation versions and method'}),
    el('p',{text:proof.owner?`Owner recorded in the contract: ${proof.owner}.`:'Accountable owner not recorded.'}),
    el('p',{text:proof.method||'Evaluation method not recorded.'}),proof.evidenceMaxAgeHours?el('p',{text:`Current evidence age limit: ${proof.evidenceMaxAgeHours} hours.`}):null,retainedMethods(d),
    d.evaluations.available?el('p',{text:`${d.evaluations.omitted} evaluation rows omitted from this bounded read.`}):null,
    d.evaluations.available?el('ul',{},d.evaluations.rows.map(e=>el('li',{text:`${date(e.evaluatedAtMs)}; version ${e.contractHash}; ${e.status}`}))):el('p',{text:'Evaluation history cannot be read.'})));
  return panel;
}
