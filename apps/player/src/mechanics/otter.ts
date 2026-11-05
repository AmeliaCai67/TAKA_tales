import type {MechanicCtx,MechanicHandle} from './types';
import {pack} from '../pack';
import {lang} from '../i18n';
import {speechPref} from '../settings';
import {soundEffectsOn} from '../sfx';
import {stopSpeech,playSpeechCues} from '../speech';
import {storyState,updateStoryState,storyVariables,resolveStoryText} from '../story-state';
import {mountNameAsr} from './otter/name-asr';
import {requestStoryReply,generationError} from '../generation-client';
import {Stage} from './otter/runtime/stage.mjs';
import type {SpeechCue} from '../speech-cues';
import './otter/style.css';
const API_BASE: string = import.meta.env.VITE_API_BASE || '';
interface Decl {type:string;kind:string;dataFile:string;mapFile:string;assetBase:string;next:string;achievement?:string;choices?:{text:string;next:string}[];freeInputNext?:string;}
export function mountOtter(ctx:MechanicCtx):MechanicHandle{
 const decl=ctx.decl as unknown as Decl,en=lang==='en',lifetime=new AbortController();
 let disposed=false,away=document.hidden,game:Stage|undefined,asr:ReturnType<typeof mountNameAsr>|undefined,saveAt=0;
 let generation=0,pending:AbortController|null=null,activeName=false,nameTimer:ReturnType<typeof setInterval>|undefined;
 const daisyHistory:{child:string;daisy:string}[]=[];
 let daisyDeclined=storyState().daisyRecordDeclined===true;
 const active=()=>!disposed&&!away&&ctx.spread.isConnected&&
  ![...document.querySelectorAll<HTMLElement>('.codex-overlay,#settings-overlay,.pm-overlay,.archive-overlay')].some(el=>el.getClientRects().length>0);
 document.body.classList.add('otter-active');ctx.spread.classList.add('otter-mode');ctx.host.classList.add('otter-canvas-host');
 const right=document.createElement('div');right.className='page-text otter-panel';ctx.spread.append(right);
 const title=document.createElement('h2');title.textContent=en?'Together, in the sea':'一起，在海里';
 const line=document.createElement('p');line.className='otter-caption';
 const controls=document.createElement('div');controls.className='otter-controls';
 const actions=document.createElement('div');actions.className='otter-actions';
 const status=document.createElement('p');status.className='otter-status';status.setAttribute('role','status');
 right.append(title,line,controls,actions,status);
 const hint=(text:string)=>{status.textContent=text;};
 function button(text:string,fn:()=>void,parent:HTMLElement=controls,id=''){
  const b=document.createElement('button');b.textContent=text;if(id)b.dataset.testid=id;b.onclick=()=>{if(active())fn();};parent.append(b);return b;
 }
 function nav(){if(disposed)return;game?.stop();ctx.nav(decl.next,en?'Continue':'继续');}
 function persistMaze(){if(game?.mode==='maze'&&game.m.phase!=='done')updateStoryState({maze:game.snapshot().maze,mazeVisited:[...game.m.visited]});}
 const cleanup=()=>{if(disposed)return;persistMaze();disposed=true;generation++;pending?.abort();lifetime.abort();clearInterval(nameTimer);asr?.destroy();game?.cleanup();stopSpeech();document.body.classList.remove('otter-active');ctx.spread.classList.remove('otter-mode','otter-maze-mode','otter-lamp-mode');right.remove();};
 window.addEventListener('blur',()=>{away=true;game?.stop();stopSpeech();asr?.cancel();persistMaze();},{signal:lifetime.signal});
 window.addEventListener('focus',()=>{away=document.hidden;},{signal:lifetime.signal});
 document.addEventListener('visibilitychange',()=>{away=document.hidden;if(away){game?.stop();stopSpeech();asr?.cancel();persistMaze();}},{signal:lifetime.signal});
 window.addEventListener('pagehide',persistMaze,{signal:lifetime.signal});
 void (async()=>{
  try{
   const [data,map]=await Promise.all([decl.dataFile,decl.mapFile].map(async path=>{const r=await fetch(pack().baseUrl+path,{signal:lifetime.signal});if(!r.ok)throw Error('data');return r.json();}));
   if(disposed)return;
   const cues=(key:string):SpeechCue[]=>(data.speechCues?.[key]||[]).map((cue:SpeechCue)=>cue.kind==='static'?{...cue,file:pack().baseUrl+cue.file}:cue);
   const say=(key:string)=>playSpeechCues(cues(key),storyVariables());
   const speakDaisy=(text:string)=>{if(active())void playSpeechCues([{id:'daisy-reply',kind:'tts',who:'daisy',template:text.replace(/^Daisy[：:]\s*/,''),atomic:true}],storyVariables());};
   let takingSpeech:ReturnType<typeof playSpeechCues>|undefined;
   const naming=decl.type==='otter-naming',kind=decl.kind;
   if(naming){
    const image=document.createElement('img');image.className='otter-naming-actor';image.src=pack().baseUrl+decl.assetBase+'otter.svg';image.alt=en?'Little Otter':'小海獭';ctx.host.append(image);
    title.textContent=data.naming.title||(en?'A name for the little otter':'给小海獭起个名字');
    const input=document.createElement('input');input.id='otter-name';input.maxLength=24;input.autocomplete='off';input.placeholder=en?'A name for the little otter':'小海獭的新名字';input.setAttribute('aria-label',input.placeholder);controls.append(input);
    const confirm=button(data.naming.confirm||(en?'Confirm name':'确认名字'),()=>void accept(),controls,'confirm-name');
    const skip=button(data.naming.skip||(en?"Let's call you Tata":'先叫塔塔吧'),()=>useDefault(),controls,'skip-name');
    const mic=document.createElement('button');mic.id='asrButton';mic.innerHTML='<span id="asrLabel">说出名字</span><span id="asrClock" hidden></span>';
    const cancel=document.createElement('button');cancel.id='cancelAsr';cancel.textContent='取消录音';cancel.hidden=true;
    const note=document.createElement('small');note.id='asrNote';note.textContent=en?'Check the spelling before confirming.':'语音识别先填字，确认后才命名。';
    controls.append(mic,cancel,note);status.id='otter-name-status';
    const saved=storyState();input.value=typeof saved.otterName==='string'?saved.otterName:'';
    const resetIdle=()=>{idleAt=performance.now();};let idleAt=performance.now();
    function busy(){confirm.disabled=activeName||!!asr?.active;skip.disabled=activeName;}
    if(!en)asr=mountNameAsr(mic,cancel,{beforeStart:()=>stopSpeech(),onState:()=>{resetIdle();busy();},onStatus:hint,onResult:text=>{input.value=text;hint('看看字对不对，再确认名字。');}});else{mic.hidden=true;}
    input.oninput=()=>{generation++;pending?.abort();activeName=false;asr?.cancel();resetIdle();busy();};
    function done(text:string,custom:boolean,feedback=''){
     clearInterval(nameTimer);asr?.destroy();asr=undefined;controls.replaceChildren();line.textContent=resolveStoryText(text);actions.replaceChildren();
     button(en?'Continue →':'继续 →',nav,actions,'naming-next');
     if(custom&&decl.achievement)ctx.unlockAchievement(decl.achievement);
     if(custom){const cue=data.naming.cues[0];void playSpeechCues([...cues(feedback),cue],storyVariables());}else say('naming-default');
    }
    function useDefault(){updateStoryState({otterName:data.naming.defaultName,nameSource:'default'});done(data.naming.defaultReply||'塔卡：那……我叫你塔塔吧？我们都有一个“塔”字。\n小海獭：塔塔！转一个！',false);}
    async function accept(){
     if(activeName||asr?.active||!input.value.trim())return;activeName=true;busy();const mine=++generation,controller=new AbortController();pending=controller;hint(en?'Signing in…':'正在登记…');
     const unavailable=en?'Naming is temporarily unavailable. Please try again.':'暂时没能登记名字，再试一次吧。';
     const timeout=setTimeout(()=>controller.abort(),15000);let rejected=false;
     try{const r=await fetch(API_BASE+'/api/naming/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:input.value.trim(),lang}),signal:controller.signal});const body=await r.json().catch(()=>null);if(disposed||mine!==generation)return;
      if(!r.ok){rejected=r.status===422;throw Error(rejected&&typeof body?.detail==='string'?body.detail:unavailable);}
      if(typeof body?.name!=='string'||!body.name.trim())throw Error(unavailable);
      updateStoryState({otterName:body.name,nameSource:'child-input'});hint(body.easterEgg||'');done(data.naming.validReply,true,body.easterEgg?(data.naming.feedbackNames[body.name.toLowerCase()]||''):'');
     }catch(error){if(!disposed&&mine===generation){hint(rejected&&error instanceof Error?error.message:unavailable);if(rejected)say(data.naming.feedbackNames[input.value.trim().toLowerCase()]||'naming-rejected');}}
     finally{clearTimeout(timeout);if(!disposed&&mine===generation){activeName=false;pending=null;busy();}}
    }
    nameTimer=setInterval(()=>{if(!active()||activeName||asr?.active){resetIdle();return;}if(!input.value.trim()&&performance.now()-idleAt>=60000)useDefault();},500);
    return;
   }
   const canvas=document.createElement('canvas');canvas.tabIndex=0;canvas.setAttribute('aria-label',en?'Story activity':'故事互动');ctx.host.append(canvas);
   const maze=data.maze;
   game=new Stage(canvas,{map,script:maze,assetBase:pack().baseUrl+decl.assetBase,soundAssets:{laugh:data.soundAssets?.laugh?pack().baseUrl+data.soundAssets.laugh:undefined},hint,event:event,isActive:active,lang});
   if(import.meta.env.DEV)Object.defineProperty(canvas,'takaSnapshot',{get:()=>disposed?null:game?.snapshot()});
   game.otterName=storyState().otterName|| (en?'Tata':'塔塔');game.set(kind,ctx.sceneKey);
   const labels:Record<string,string>={lamp:en?'Turn up the light':'调亮探照灯',maze:en?'Listen for the shell':'听音寻路找贝壳',material:en?'Tap and listen':'敲一敲，听一听',g:en?'One little spin':'水上超级大旋转',h:en?'We can do it too!':'我们也会！',ripple:en?'Ripples on the water':'水面涟漪'};
   title.textContent=labels[kind];
   const next=button(en?'Continue →':'继续 →',nav,actions,'activity-next');
   let invitation:HTMLElement|undefined;
   if(kind==='lamp'){
    game.small.registration=true;
    ctx.spread.classList.add('otter-lamp-mode');title.textContent=pack().title;
    line.textContent=resolveStoryText(ctx.scene.text);
    if(ctx.scene.speechCue)void playSpeechCues([{id:'registration',kind:'tts',...ctx.scene.speechCue}],storyVariables());
    next.disabled=true;
    canvas.setAttribute('aria-label',en?'Slide the searchlight up to brighten it':'向上拖动塔卡的探照灯，让管道亮起来');
    canvas.addEventListener('keydown',event=>{if(event.key==='ArrowUp'&&active()){event.preventDefault();game?.action('lamp',Math.min(1,game.small.lamp.target+.3));}},{signal:lifetime.signal});
   }else if(kind==='maze'){
    ctx.spread.classList.add('otter-maze-mode');
    const hud=document.createElement('div');hud.className='otter-maze-hud';ctx.spread.append(hud);hud.append(title,line,controls,actions,status);right.remove();
    line.textContent=en?data.maze.instructions[0]:'拖动塔卡，在半透明的管道里找贝壳。主路碰墙是清脆的叮，岔路碰墙是闷响。';next.hidden=true;
    button(en?'3-second map':'三秒地图',()=>game?.action('map'),controls,'maze-map');button(en?'Ask Daisy':'问 Daisy',help,controls,'maze-help');
    document.addEventListener('keydown',e=>{if(e.target instanceof HTMLInputElement||!active())return;const dirs:Record<string,number[]>={ArrowUp:[0,-1],ArrowDown:[0,1],ArrowLeft:[-1,0],ArrowRight:[1,0]};if(dirs[e.key]){e.preventDefault();if(!e.repeat)game?.action('dir',dirs[e.key]);}},{signal:lifetime.signal});
    const checkpoint=storyState();const m=checkpoint.maze as {point?:number[];phase?:string}|undefined;
    if(m?.point&&game.maze.canOccupy(m.point)){game.m.point=m.point;game.m.visited=new Set(Array.isArray(checkpoint.mazeVisited)?checkpoint.mazeVisited:[]);if(['found','taking','done'].includes(m.phase||'')){game.m.phase='found';event('found');}}
   }else if(kind==='material'){line.textContent=data.material.instruction||data.material.sourceRaw;}
   else if(kind==='g'){line.textContent=data.otterSpin.instruction||'用手指绕小海獭划圈加速，轻点它停下来。';}
   else if(kind==='h'){line.textContent=en?'Tap the picture to begin, then tap with the light. Missing a beat is fine.':'点一下画面开始，再跟着光点点。漏拍也没关系。';next.disabled=true;button(data.robotSpin.auto||(en?'Let them spin':'让它们自己转'),()=>game?.action('rhythm',true),controls,'auto-rhythm');}
   else if(kind==='ripple'){
    line.textContent=data.ripples.instruction||'轻轻碰一下水面，看看涟漪慢慢散开。';
    if(decl.choices){
     actions.replaceChildren();for(const c of decl.choices)button(c.text,()=>ctx.nav(c.next,c.text),actions);
     const input=document.createElement('input');input.maxLength=300;input.placeholder=en?'What would you like to say?':'还想说些什么？';actions.append(input);
     const send=button(en?'Say it':'说好了',()=>void submit(),actions);
     async function submit(){
      const text=input.value.trim();if(!text||!decl.freeInputNext||send.disabled)return;
      input.disabled=send.disabled=true;hint(en?'Daisy is listening…':'Daisy 正在听…');
      try{
       const reply=await requestStoryReply(decl.freeInputNext,ctx.scene.text,text,ctx.sceneKey);
       if(disposed)return;
       if(reply.type==='stay'){hint(reply.text);speakDaisy(reply.text);}
       else ctx.nav(decl.freeInputNext,text,reply.type==='advance'?reply.text:undefined);
      }catch(error){if(!disposed)hint(generationError(error));}
      finally{if(!disposed)input.disabled=send.disabled=false;}
     }
    }
   }
   function syncEffects(){game?.mute(soundEffectsOn());}
   syncEffects();document.addEventListener('taka-sfx-change',syncEffects,{signal:lifetime.signal});
   document.addEventListener('taka-volume-change',()=>{game!.config.volume=speechPref.volume;game!.mazeConfig.volume=speechPref.volume;},{signal:lifetime.signal});
   function help(){
    const existing=ctx.spread.querySelector('.otter-copilot');if(existing){existing.remove();return;}
    const panel=document.createElement('div');panel.className='otter-copilot';ctx.spread.append(panel);
    button(en?'Close Daisy':'收起 Daisy',()=>panel.remove(),panel);
    button(en?'Next small hint':'告诉我下一段',()=>game?.action('hint'),panel);
    const input=document.createElement('input');input.maxLength=300;input.placeholder=en?'Ask Daisy…':'想问 Daisy 什么？';panel.append(input);
    const send=button(en?'Ask':'问一问',()=>void submit(),panel);
    async function submit(){
     const text=input.value.trim();if(!text||send.disabled||!game)return;
     const position=game.snapshot().maze?.point as [number,number]|undefined;
     input.disabled=send.disabled=true;hint(en?'Daisy is listening…':'Daisy 正在听…');
     try{
      const reply=await requestStoryReply(ctx.sceneKey,ctx.scene.text,text,ctx.sceneKey,{position,history:daisyHistory.slice(-6),record_declined:daisyDeclined});
      if(disposed||!panel.isConnected)return;
      if(reply.type==='ignore'){hint('');return;}
      hint(reply.text);speakDaisy(reply.text);
      if(reply.type==='advance'){
       daisyHistory.push({child:text,daisy:reply.text});if(daisyHistory.length>6)daisyHistory.shift();input.value='';
       if(/不(?:入档|记录|留档)|won['’]t (?:record|archive)/i.test(reply.text)){daisyDeclined=true;updateStoryState({daisyRecordDeclined:true});}
      }
     }catch(error){if(!disposed&&panel.isConnected)hint(generationError(error));}
     finally{if(!disposed&&panel.isConnected)input.disabled=send.disabled=false;}
    }
   }
   function event(name:string,arg?:{count:number;required:number;key?:string}){
    if(disposed)return;
    if(name==='speech'&&arg?.key)say(arg.key);
    if(name==='lamp'){next.disabled=false;hint(data.lamp.complete||'灯亮了，维修管道亮起来了。');}
    if(name==='rhythm'){next.disabled=false;line.textContent=data.robotSpin.fall||'塔卡的履带/机械脚一滑，直接绊到了礁石，“啪嗒！哐当！”两个机器人像高楼积木一样重重地摔倒成一团！';}
    if(name==='beat'&&arg)hint(`${arg.count} / ${arg.required}`);
    if(name==='invite'){
     say('maze-invite');invitation=document.createElement('div');invitation.className='otter-invite';invitation.textContent=maze.invite;controls.append(invitation);button(maze.helpYes||(en?'Yes':'要'),()=>{game?.action('hint');invitation?.remove();},invitation);button(maze.helpNo||(en?'No':'不要'),()=>{hint(maze.decline);say('maze-decline');invitation?.remove();},invitation);
    }
    if(name==='found'){
     ctx.spread.querySelector('.otter-copilot')?.remove();
     invitation?.remove();line.textContent=maze.found+'\n'+resolveStoryText(maze.otterFound);controls.replaceChildren();actions.replaceChildren();game!.pickupEnabled=false;
     const take=button(maze.take||(en?'Take out the shell':'取出贝壳'),()=>game?.action('take'),actions,'take-shell');take.disabled=true;
     void say('maze-found').then(()=>{if(!disposed&&game?.m.phase==='found'){game.pickupEnabled=true;take.disabled=false;}});persistMaze();
    }
    if(name==='taking'){line.textContent=maze.taking;takingSpeech=say('maze-taking');actions.replaceChildren();}
    if(name==='taken'){void Promise.resolve(takingSpeech).then(()=>{if(disposed)return;updateStoryState({maze:null,mazeVisited:[]});nav();});}
   }
   const frame=()=>{if(disposed)return;if(performance.now()-saveAt>700){persistMaze();saveAt=performance.now();}requestAnimationFrame(frame);};requestAnimationFrame(frame);
   // Match native sound preference; effects stay usable when narration is disabled.
   game.config.volume=speechPref.volume;game.mazeConfig.volume=speechPref.volume;
  }catch(error){if(disposed)return;hint(en?'The activity could not load. Reload to try again.':'互动暂时没载入，刷新后再试一次。');console.error(error);}
 })();
 return {cleanup};
}
