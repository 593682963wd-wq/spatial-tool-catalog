import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('static/js/ai-live-clean/app.js','utf8');
function functionSource(name) {
  const pattern=new RegExp(`^(?:async )?function ${name}\\(.*\\) \\{`,'m');
  const head=pattern.exec(source);assert.ok(head,`missing ${name}`);
  let depth=1,quote=null,escaped=false,comment=null,index=head.index+head[0].length;
  for(;index<source.length;index++) {
    const ch=source[index],next=source[index+1];
    if(comment==='line'){if(ch==='\n')comment=null;continue;}
    if(comment==='block'){if(ch==='*'&&next==='/'){comment=null;index++;}continue;}
    if(quote){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch===quote)quote=null;continue;}
    if(ch==='/'&&next==='/'){comment='line';index++;continue;}
    if(ch==='/'&&next==='*'){comment='block';index++;continue;}
    if(ch==='"'||ch==="'"||ch==='`'){quote=ch;continue;}
    if(ch==='{')depth++;else if(ch==='}'&&!--depth)return source.slice(head.index,index+1);
  }
  throw new Error(`unclosed ${name}`);
}
const noop=()=>{};
const node=()=>({hidden:true,dataset:{},classList:{add:noop,remove:noop},focus:noop,setAttribute:noop});
function context(extra={}) {
  const texts={},broadcasts=[],previewPanel=node(),stage=node();
  const state={visitorMode:false,previewToolId:null};
  const env={console,config:{apiBase:'/api',launchEnabled:false},role:'controller',tools:[{id:'A',name:'A'},{id:'B',name:'B'}],visibleTools:[],toolNodes:new Map(),root:{dataset:{}},pointer:node(),stage,previewPanel,lensContent:node(),lensLoading:node(),scene:new Proxy({},{get:()=>noop}),sync:{send:(...args)=>broadcasts.push(args)},store:{getState:()=>state,dispatch:(a)=>{if(a.type==='PREVIEW_CHANGED')state.previewToolId=a.toolId;}},text:(selector,value)=>texts[selector]=value,q:()=>node(),focusTool:noop,setExperienceState:noop,normalizedAnchorForElement:()=>({x:0.5,y:0.5}),toolTone:()=>'',humanToolStatus:()=>'',renderToolIcon:noop,toolIsFixture:()=>false,setCoach:noop,updateBridgePath:noop,updateSceneAnchors:noop,currentTool:()=>({id:'A',name:'A'}),startVisitorTour:noop,gestureConfirmSince:0,gestureConfirmFired:false,...extra};
  const ctx=vm.createContext(env);vm.runInContext('let previewRequest=0;',ctx);
  return {ctx,env,texts,broadcasts,state};
}
const mode=process.argv[2];
if(mode==='race') {
  const pending=[];const x=context({fetch:()=>new Promise(resolve=>pending.push(resolve))});
  vm.runInContext(functionSource('showPreview')+'\n'+functionSource('closePreview'),x.ctx);
  const a=vm.runInContext("showPreview('A')",x.ctx),b=vm.runInContext("showPreview('B')",x.ctx);
  const response=name=>({ok:true,json:async()=>({ok:true,preview:{tool:{id:name,name,summary:`Summary ${name}`}}})});
  pending[1](response('B'));await b;pending[0](response('A'));await a;
  assert.equal(x.texts['[data-preview-title]'],'B');
  assert.deepEqual(x.broadcasts.map(item=>item[1].toolId),['B']);
  const late=vm.runInContext("showPreview('A')",x.ctx);
  vm.runInContext('closePreview()',x.ctx);pending[2](response('A'));await late;
  assert.equal(x.env.previewPanel.hidden,true);
  assert.equal(x.state.previewToolId,null);
} else if(mode==='keyboard') {
  let callback,moves=0,previews=0;
  const x=context({moveFocus:()=>moves++,showPreview:()=>previews++,settingsPanel:{hidden:true},closeSettings:noop});
  x.env.stage.addEventListener=(name,fn)=>{assert.equal(name,'keydown');callback=fn;};
  const start=source.indexOf('stage.addEventListener("keydown",');
  vm.runInContext(source.slice(start,source.indexOf('\n});',start)+4),x.ctx);
  for(const key of [' ','ArrowRight','ArrowLeft','Home','End','Enter']) {
    let prevented=false;
    callback({key,target:{closest:()=>({matches:()=>false})},preventDefault:()=>prevented=true});
    assert.equal(prevented,false,`${key} was consumed by stage`);
  }
  assert.equal(moves,0);assert.equal(previews,0);
} else if(mode==='source_id') {
  const idLine=source.split('\n').filter(line=>line.startsWith('const sourceId =')||line.startsWith('const displayPrefix =')).join('\n');
  for(const displayId of ['a'.repeat(56),'a'.repeat(64),'中文-__']) {
    const ctx=vm.createContext({config:{displayId},role:'center',crypto:{randomUUID:()=> 'a1234567-0000-0000-0000-000000000000'}});
    const id=vm.runInContext(idLine+'\nsourceId',ctx);
    assert.match(id,/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
  }
} else if(mode==='snapshot') {
  let callback;const worlds=[],x=context();
  x.env.sync.onMessage=fn=>callback=fn;x.env.scene={setWorld:world=>worlds.push(world)};
  vm.runInContext(functionSource('changeWorld'),x.ctx);
  const start=source.indexOf('sync.onMessage('),end=source.indexOf('\nsync.start()',start);
  vm.runInContext(source.slice(start,end),x.ctx);
  callback({type:'STATE_SNAPSHOT',payload:{world:'starship_matrix'},sent_at_ms:1},'test');
  assert.deepEqual(worlds,['starship_matrix']);
} else if(mode==='launch') {
  const response={ok:true,json:async()=>({ok:true,open_path:null})};
  const states=[];const x=context({config:{apiBase:'/api',launchEnabled:true},fetch:async()=>response,allowedLaunchUrl:()=>null,flashAt:noop,announce:noop,innerWidth:100,innerHeight:100,setExperienceState:value=>states.push(value)});
  x.state.previewToolId='A';vm.runInContext(functionSource('launchCurrentTool'),x.ctx);
  await vm.runInContext('launchCurrentTool()',x.ctx);
  assert.match(x.texts['[data-launch-message]'],/工具已启动/);assert.deepEqual(states,['launching','preview']);
  for(const fail of [false,true]) {
    let complete;const states=[];const y=context({config:{apiBase:'/api',launchEnabled:true},fetch:()=>new Promise((resolve,reject)=>complete=fail?reject:resolve),setExperienceState:value=>states.push(value)});
    y.state.previewToolId='A';vm.runInContext(functionSource('launchCurrentTool'),y.ctx);const pending=vm.runInContext('launchCurrentTool()',y.ctx);
    vm.runInContext('previewRequest += 1',y.ctx);y.state.previewToolId='B';y.texts['[data-launch-message]']='new preview';complete(fail?new Error('old request failed'):response);await pending;
    assert.equal(y.texts['[data-launch-message]'],'new preview');assert.deepEqual(states,['launching']);
  }
} else throw new Error(`unknown case ${mode}`);
console.log(`${mode}: passed`);
