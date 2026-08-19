const es=require('/tmp/node_modules/esbuild'), fs=require('fs'), assert=require('assert');
const src=fs.readFileSync('/sessions/serene-focused-planck/mnt/abrobot-crm-app/supabase/functions/_shared/automations.ts','utf8');
const js=es.transformSync(src,{loader:'ts',format:'cjs'}).code;
const m={exports:{}}; new Function('module','exports',js)(m,m.exports);
const {shouldRun,testCondition,triggerFires,inCooldown,conditionsPass,describeAutomation}=m.exports;

const NOW=new Date('2026-08-19T12:00:00Z');
const hoursAgo=(h)=>new Date(NOW.getTime()-h*3600000).toISOString();
const base={id:'a1',org_id:'o1',name:'R',enabled:true,trigger:'no_contact_for',trigger_value:48,conditions:[],actions:[{action:'add_note'}],cooldown_hours:24};
const lead={id:'l1',name:'X',score:60,stage_key:'new',source:'whatsapp',last_contacted_at:hoursAgo(72),created_at:hoursAgo(200),custom:{budget:500000}};

let pass=0,fail=0;
const t=(n,f)=>{try{f();console.log('  ✓',n);pass++}catch(e){console.log('  ✗',n,'\n     ',e.message);fail++}};

t('no_contact_for fires past threshold',()=>assert(triggerFires(base,lead,NOW)));
t('no_contact_for does not fire inside threshold',()=>assert(!triggerFires(base,{...lead,last_contacted_at:hoursAgo(12)},NOW)));
t('never-contacted falls back to created_at',()=>assert(triggerFires(base,{...lead,last_contacted_at:null},NOW)));
t('disabled rule never runs',()=>assert(!shouldRun({...base,enabled:false},lead,null,NOW)));
t('cooldown blocks a recent run',()=>assert(!shouldRun(base,lead,hoursAgo(2),NOW)));
t('cooldown expires',()=>assert(shouldRun(base,lead,hoursAgo(30),NOW)));
t('conditions gate the rule',()=>{
  assert(shouldRun({...base,conditions:[{field:'source',op:'eq',value:'whatsapp'}]},lead,null,NOW));
  assert(!shouldRun({...base,conditions:[{field:'source',op:'eq',value:'email'}]},lead,null,NOW));
});
t('numeric compare on score',()=>{
  assert(testCondition(lead,{field:'score',op:'gt',value:50}));
  assert(!testCondition(lead,{field:'score',op:'gt',value:80}));
});
t('custom.* fields resolve',()=>assert(testCondition(lead,{field:'custom.budget',op:'gte',value:400000})));
t('is_empty / not_empty',()=>{
  assert(testCondition({...lead,email:null},{field:'email',op:'is_empty'}));
  assert(testCondition(lead,{field:'name',op:'not_empty'}));
});
t('ordering op on text is inert, not a guess',()=>assert(!testCondition(lead,{field:'name',op:'gt',value:'A'})));
t('follow_up_overdue respects grace',()=>{
  const a={...base,trigger:'follow_up_overdue',trigger_value:6};
  assert(triggerFires(a,{...lead,next_follow_up_at:hoursAgo(10)},NOW));
  assert(!triggerFires(a,{...lead,next_follow_up_at:hoursAgo(2)},NOW));
});
t('score_above / score_below',()=>{
  assert(triggerFires({...base,trigger:'score_above',trigger_value:50},lead,NOW));
  assert(triggerFires({...base,trigger:'score_below',trigger_value:70},lead,NOW));
});
t('event triggers need the event',()=>{
  const a={...base,trigger:'lead_created'};
  assert(!triggerFires(a,lead,NOW));
  assert(triggerFires(a,lead,NOW,'lead_created'));
});
t('empty conditions pass',()=>assert(conditionsPass(lead,[])));
t('describeAutomation is human readable',()=>{
  const s=describeAutomation({...base,conditions:[{field:'source',op:'eq',value:'whatsapp'}],actions:[{action:'set_stage',value:'contacted'}]});
  assert(s.includes('no contact for 48 hours')&&s.includes('source is whatsapp')&&s.includes('move to contacted'),s);
});
t('inCooldown handles null',()=>assert(!inCooldown(null,24,NOW)));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
