import {lang} from '../i18n';
import {figure,loadActor} from '../scene-host';
import {storyState,updateStoryState} from '../story-state';
import {InteractionAudio} from './interaction-audio';
import type {MechanicCtx,MechanicHandle} from './types';
import './journey.css';
interface JourneyDecl{type:'journey';kind:'ascent'|'whale-ride';next:string;}
export function mountJourney(ctx:MechanicCtx):MechanicHandle{
 const decl=ctx.decl as JourneyDecl,en=lang==='en',life=new AbortController();let disposed=false,away=document.hidden,frame=0,auto=false,ending=false,pointer:number|null=null,travel=0,last=[0,0],at=performance.now(),lastWater=0,lastSave=0,spinUntil=0,turns=0,breachRemaining=0,transitioned=false,lastAngle:number|null=null,arcTotal=0,gestureCentre=[50,60];
 const stored=storyState().journeys as Record<string,{progress?:number;x?:number;y?:number}>||{},old=stored[ctx.sceneKey]||{};
 let progress=Math.min(.98,Math.max(0,old.progress||0)),x=old.x||50,y=decl.kind==='ascent'?84-progress*72:old.y||60,target=[x,y];
 const active=()=>!disposed&&!away&&ctx.spread.isConnected&&![...document.querySelectorAll<HTMLElement>('#settings-overlay,.codex-overlay,.pm-overlay')].some(e=>e.getClientRects().length);
 const sound=new InteractionAudio(active);ctx.spread.classList.add('journey-mode');document.body.classList.add('journey-active');ctx.host.classList.add('journey-canvas','journey-'+decl.kind);
 const panel=document.createElement('section');panel.className='page-text journey-panel';
 const title=document.createElement('h2');title.textContent=decl.kind==='ascent'?(en?'Follow the sound up':'循声上浮'):(en?'A ride on a whale':'鲸背大旅行');
 const instruction=document.createElement('p');instruction.textContent=decl.kind==='ascent'?(en?'Drag TAKA up, or tap the water above. The wind grows clearer near the surface.':'向上拖动塔卡，或点上方水域。靠近水面，呼呼声会更清楚。'):(en?'Tap the water to swim. Draw a circle to turn together. Surface whenever you like.':'点一处水域游过去，划一个圈一起转。想看彩虹时，就上浮吧。');
 const footer=document.createElement('div');footer.className='journey-actions';const go=document.createElement('button');go.className='journey-next';go.dataset.testid='journey-next';go.textContent=decl.kind==='ascent'?(en?'Keep going up':'继续上浮'):(en?'Surface':'上浮');footer.append(go);
 const status=document.createElement('p');status.className='journey-status';status.setAttribute('role','status');panel.append(title,instruction,status,footer);ctx.spread.append(panel);
 const world=document.createElement('div');world.className='journey-world';ctx.host.append(world);
 const glow=document.createElement('div');glow.className='journey-surface-light';world.append(glow);
 const actor=document.createElement('button');actor.className='journey-swimmer';actor.setAttribute('aria-label',decl.kind==='ascent'?(en?'Move TAKA':'移动塔卡'):(en?'Move the whale':'移动鲸鱼'));actor.dataset.testid='journey-actor';world.append(actor);
 const taka=figure().querySelector('svg')!.cloneNode(true) as SVGElement;
 if(decl.kind==='ascent')actor.append(taka);
 else{
  actor.classList.add('journey-whale');const body=document.createElement('span');body.className='journey-whale-body';actor.append(body);void loadActor('whale').then(svg=>{if(!disposed&&svg)body.innerHTML=svg;});
  const rider=document.createElement('span');rider.className='journey-rider journey-taka';rider.append(taka);actor.append(rider);
  const r757=document.createElement('span');r757.className='journey-rider journey-757';actor.append(r757);void loadActor('r757').then(svg=>{if(!disposed&&svg)r757.innerHTML=svg;});
  const circle=document.createElement('button');circle.className='journey-circle';circle.textContent=en?'One little turn':'转一圈';circle.dataset.testid='journey-circle';world.append(circle);circle.onclick=e=>{e.stopPropagation();turn();};
 }
 const save=()=>updateStoryState({journeys:{...(storyState().journeys as Record<string,unknown>||{}),[ctx.sceneKey]:{progress,x,y}}});
 const bubbles=document.createElement('span');bubbles.className='journey-bubbles';bubbles.innerHTML='<i></i><i></i><i></i>';actor.append(bubbles);
 const moveActor=()=>{actor.style.left=x+'%';actor.style.top=y+'%';world.style.setProperty('--journey-depth',String(progress));};moveActor();
 function turn(){if(!active()||ending)return;spinUntil=performance.now()+2400;turns++;actor.classList.toggle('journey-flip',turns%2===0);actor.classList.remove('journey-turn');void actor.offsetWidth;actor.classList.add('journey-turn');sound.play('water');sound.play('whale');}
 function finish(){if(ending||disposed)return;ending=true;breachRemaining=.85;progress=1;save();ctx.spread.classList.add('journey-breach');sound.play('splash');}
 const position=(e:PointerEvent)=>{const r=ctx.host.getBoundingClientRect();return [Math.max(8,Math.min(92,(e.clientX-r.left)/r.width*100)),Math.max(8,Math.min(88,(e.clientY-r.top)/r.height*100))];};
 const steer=(p:number[])=>{target=p;if(decl.kind==='ascent'){progress=Math.max(progress,Math.min(1,(84-p[1])/72));target[1]=84-progress*72;}if(performance.now()-lastWater>280){sound.play('propeller');if(decl.kind==='ascent')sound.play('wind',0,.2+progress*.8);lastWater=performance.now();}};
 world.addEventListener('pointerdown',e=>{if(!active()||ending||e.button!==0||(e.target as Element).closest('.journey-circle'))return;pointer=e.pointerId;travel=0;last=position(e);lastAngle=null;arcTotal=0;gestureCentre=[x,y];world.setPointerCapture(e.pointerId);steer(last);e.preventDefault();},{signal:life.signal});
 world.addEventListener('pointermove',e=>{if(pointer!==e.pointerId||!active()||ending)return;const p=position(e);travel+=Math.hypot(p[0]-last[0],p[1]-last[1]);last=p;if(decl.kind==='whale-ride'){const angle=Math.atan2(p[1]-gestureCentre[1],p[0]-gestureCentre[0]);if(lastAngle!==null){const arc=Math.abs(Math.atan2(Math.sin(angle-lastAngle),Math.cos(angle-lastAngle)));if(arc<1.05)arcTotal+=arc;}lastAngle=angle;if(arcTotal>4.5){turn();arcTotal=0;}}steer(p);},{signal:life.signal});
 for(const event of ['pointerup','pointercancel'])world.addEventListener(event,()=>{pointer=null;save();},{signal:life.signal});
 actor.addEventListener('keydown',e=>{if(!active()||ending)return;const dirs:Record<string,number[]>={ArrowUp:[0,-12],ArrowDown:[0,12],ArrowLeft:[-12,0],ArrowRight:[12,0]};if(dirs[e.key]){e.preventDefault();steer([Math.max(8,Math.min(92,x+dirs[e.key][0])),Math.max(8,Math.min(88,y+dirs[e.key][1]))]);}else if(e.key==='Enter'||e.key===' '){e.preventDefault();if(decl.kind==='whale-ride')turn();else auto=true;}},{signal:life.signal});
 go.onclick=()=>{if(!active()||ending)return;auto=true;sound.play('propeller');status.textContent=en?'Up we go.':'一起上浮。';};
 const tick=(now:number)=>{const dt=Math.min(.05,(now-at)/1000);at=now;if(active()&&ending&&!transitioned){breachRemaining-=dt;if(breachRemaining<=0){transitioned=true;ctx.nav(decl.next,'');}}if(active()&&!ending){
  if(auto){progress=Math.min(1,progress+dt/(decl.kind==='ascent'?7:2.2));target=[50,84-progress*72];}
  x+=(target[0]-x)*(1-Math.exp(-dt*5));y+=(target[1]-y)*(1-Math.exp(-dt*5));
  if(decl.kind==='ascent'){status.textContent=en?`Closer to the wind · ${Math.round(progress*100)}%`:`风声越来越近 · ${Math.round(progress*100)}%`;if(progress>.99&&y<16)finish();}
  else if(auto&&progress>=1&&y<16)finish();
  if(now>spinUntil)actor.classList.remove('journey-turn');
  if((auto||pointer!==null)&&now-lastWater>600){sound.play('water');if(decl.kind==='ascent')sound.play('wind',0,.2+progress*.8);lastWater=now;}
  if(now-lastSave>1000){save();lastSave=now;}moveActor();
 }frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);
 window.addEventListener('blur',()=>{away=true;sound.stop();},{signal:life.signal});window.addEventListener('focus',()=>{away=document.hidden;},{signal:life.signal});document.addEventListener('visibilitychange',()=>{away=document.hidden;if(away)sound.stop();},{signal:life.signal});
 if(import.meta.env.DEV)Object.defineProperty(world,'journeySnapshot',{get:()=>({kind:decl.kind,progress,x,y,auto,ending,sounds:sound.events})});
 return {cleanup(){if(disposed)return;save();disposed=true;life.abort();cancelAnimationFrame(frame);sound.cleanup();world.remove();panel.remove();ctx.spread.classList.remove('journey-mode','journey-breach');document.body.classList.remove('journey-active');}};
}
