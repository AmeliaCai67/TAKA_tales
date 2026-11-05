import {pack} from '../pack';
import {lang} from '../i18n';
import {figure,loadActor} from '../scene-host';
import {storyState,updateStoryState} from '../story-state';
import {playSceneAudio,stopSpeech} from '../speech';
import {InteractionAudio,type InteractionSound} from './interaction-audio';
import type {Scene} from '../story';
import './journey.css';
export type TouchKind='clean'|'wave'|'recording'|'seaweed'|'call'|'mist'|'room'|'replay'|'magnet'|'bell'|'boat'|'torch'|'arms'|'wire';
export interface SceneTouch {id:string;kind:TouchKind;x?:number;y?:number;actor?:string;far?:boolean;}
const words:Record<TouchKind,[string,string]>={clean:['轻轻清理珊瑚','Gently clean the coral'],wave:['摸摸海面','Touch the water'],recording:['再听一段风声','Replay the wind'],seaweed:['把海草轻轻敷好','Gently place the seaweed'],call:['听听鲸群回应','Listen to the whales'],mist:['拨开水雾看彩虹','Clear the mist to see the rainbow'],room:['拖动探照灯，看看三个声源','Move the light to explore three sounds'],replay:['再听一次','Play it again'],magnet:['把画吸在墙上','Put the drawing on the wall'],bell:['拨一拨铃铛','Ring the bell'],boat:['推小船漂一会','Give the little boat a push'],torch:['照亮深海','Light up the deep sea'],arms:['轻轻碰一碰机械臂','Gently touch the robot arms'],wire:['接好那根线','Connect the wire']};
export const touchLabel=(kind:TouchKind)=>words[kind][lang==='en'?1:0];
const art:Partial<Record<TouchKind,string>>={
 bell:'<path d="M20 34q3-8 3-15a13 13 0 0 1 26 0q0 7 4 15l5 9H15z" fill="#b2a080" stroke="#506c78" stroke-width="3"/><path d="M11 44h51M32 49q5 10 10 0M36 3V0" fill="none" stroke="#cfba8b" stroke-width="3"/>',
 magnet:'<rect x="8" y="6" width="56" height="50" rx="2" fill="#d4ccb0"/><path d="M16 45l16-23 22 23M22 45h27M18 15h8" fill="none" stroke="#7c9c9f" stroke-width="3"/><path d="M29 3v8h15V3" fill="none" stroke="#ad806a" stroke-width="5"/>',
 boat:'<path d="M4 33h65L56 52H20z" fill="#8196a0" stroke="#405f70" stroke-width="3"/><path d="M35 12v21M37 13l21 17H37" stroke="#b3b8aa" fill="#8ba2a1" stroke-width="3"/><path d="M3 58q12-7 24 0t25 0t20 0" fill="none" stroke="#80b3bc" stroke-width="2"/>',
 seaweed:'<path d="M32 58q-18-16-9-30T17 3M35 58q20-20 10-32T51 3M33 57V15" fill="none" stroke="#72977d" stroke-width="7" stroke-linecap="round"/>',
 recording:'<rect x="8" y="10" width="57" height="43" rx="7" fill="#5d7784" stroke="#afc0c4" stroke-width="2"/><circle cx="25" cy="27" r="9" fill="#243b49"/><circle cx="49" cy="27" r="9" fill="#243b49"/><path d="M25 36h24M18 45h37" stroke="#b7b69e" stroke-width="2"/><path d="M33 19l10 7-10 7" fill="#d3c18b"/>',
 wire:'<path d="M4 38q13-19 24-5t21 0" fill="none" stroke="#8ca5b0" stroke-width="5"/><rect x="44" y="24" width="15" height="17" rx="3" fill="#aabbbf"/><path d="M59 27h7M59 36h7" stroke="#d3c28e" stroke-width="4"/>',
 arms:'<path d="M3 37l17-10 13 10M70 37L53 27 40 37" fill="none" stroke="#97abb4" stroke-width="8" stroke-linecap="round"/><circle cx="33" cy="37" r="6" fill="#617d8a"/><circle cx="40" cy="37" r="6" fill="#617d8a"/>',
};
const svg=(body:string)=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 74 64" aria-hidden="true">${body}</svg>`;
export function mountSceneTouches(scene:Scene,sceneKey:string,host:HTMLElement){
 const items=scene.interactions||[];if(!items.length)return {cleanup(){}};
 let disposed=false,activePointer:number|null=null;const life=new AbortController(),layer=document.createElement('div');layer.className='scene-touches';host.classList.add('has-touches');host.append(layer);
 const active=()=>!disposed&&!document.hidden&&host.isConnected&&![...document.querySelectorAll<HTMLElement>('#settings-overlay,.codex-overlay,.cf-overlay')].some(el=>el.getClientRects().length);
 const sound=new InteractionAudio(active);const status=document.createElement('span');status.className='touch-feedback';status.setAttribute('role','status');layer.append(status);
 const timers=new Set<ReturnType<typeof setTimeout>>();const later=(fn:()=>void,ms:number)=>{const t=setTimeout(()=>{timers.delete(t);if(!disposed)fn();},ms);timers.add(t);};
 const saved=()=>storyState().touches as Record<string,{x?:number;y?:number;done?:boolean}>||{};
 const persist=(it:SceneTouch,data:{x?:number;y?:number;done?:boolean})=>updateStoryState({touches:{...saved(),[sceneKey+':'+it.id]:data}});
 let source:HTMLElement|undefined;
 const illuminate=(x:number,y:number)=>{
  host.style.setProperty('--touch-light-x',x+'%');host.style.setProperty('--touch-light-y',y+'%');
  const choices=[...host.querySelectorAll<HTMLElement>('.hotspot')].map(h=>({h,d:Math.hypot(parseFloat(h.style.left)-x,parseFloat(h.style.top)-y)})).sort((a,b)=>a.d-b.d);
  const nearest=choices[0]?.d<23?choices[0].h:undefined;
  for(const {h} of choices)h.classList.toggle('touch-near',h===nearest);
  if(nearest&&nearest!==source)sound.play(nearest.dataset.actor==='green'?'recorder':nearest.dataset.actor==='screen'?'screen':'door');source=nearest;
 };
 const note=(text:string)=>{status.textContent=text;};
 const ripple=(x:number,y:number)=>{const ring=document.createElement('i');ring.className='touch-ripple';ring.style.left=x+'%';ring.style.top=y+'%';layer.append(ring);later(()=>ring.remove(),1800);};
 function coords(e:PointerEvent){const r=host.getBoundingClientRect();return [Math.max(4,Math.min(96,(e.clientX-r.left)/r.width*100)),Math.max(7,Math.min(93,(e.clientY-r.top)/r.height*100))];}
 for(const it of items){
  const kind=it.kind;
  if(kind==='wave'||kind==='mist'){
   const canvas=document.createElement('canvas');canvas.className='touch-water '+(kind==='mist'?'touch-mist':'');canvas.setAttribute('aria-hidden','true');layer.prepend(canvas);
   const c=canvas.getContext('2d')!;let lastX=0,lastY=0;
   const size=()=>{const r=host.getBoundingClientRect();canvas.width=Math.max(1,r.width);canvas.height=Math.max(1,r.height);if(kind==='mist'){c.fillStyle='rgba(191,216,217,.46)';c.fillRect(0,0,canvas.width,canvas.height);}};const resize=new ResizeObserver(size);resize.observe(host);size();
   const touch=(e:PointerEvent)=>{if(!active())return;const [x,y]=coords(e);if(e.type==='pointermove'&&Math.hypot(x-lastX,y-lastY)<2)return;lastX=x;lastY=y;
    ripple(x,y);sound.play('water');if(kind==='mist'){c.globalCompositeOperation='destination-out';c.fillStyle='#000';c.beginPath();c.arc(x/100*canvas.width,y/100*canvas.height,Math.max(28,canvas.width*.11),0,Math.PI*2);c.fill();}}
   canvas.addEventListener('pointerdown',e=>{if(!active())return;activePointer=e.pointerId;canvas.setPointerCapture(e.pointerId);touch(e);e.preventDefault();},{signal:life.signal});
   canvas.addEventListener('pointermove',e=>{if(activePointer===e.pointerId)touch(e);},{signal:life.signal});
   for(const event of ['pointerup','pointercancel'])canvas.addEventListener(event,()=>{activePointer=null;},{signal:life.signal});
   life.signal.addEventListener('abort',()=>resize.disconnect(),{once:true});
   const help=document.createElement('span');help.className='touch-instruction';help.textContent=touchLabel(kind);layer.append(help);continue;
  }
  const button=document.createElement('button');button.type='button';button.className='scene-touch touch-'+kind;button.dataset.touch=it.id;button.setAttribute('aria-label',touchLabel(kind));button.title=touchLabel(kind);
  const old=saved()[sceneKey+':'+it.id];button.style.left=(old?.x??it.x??50)+'%';button.style.top=(old?.y??it.y??76)+'%';
  const picture=document.createElement('span');picture.className='touch-art';button.append(picture);
  if(art[kind])picture.innerHTML=svg(art[kind]!);else void loadActor(it.actor||(kind==='clean'?'coral':kind==='call'?'whale':kind==='replay'?'green':'light')).then(value=>{if(!disposed&&value)picture.innerHTML=value;});
  if(kind==='boat'){
   const rider=(host.querySelector('#taka-figure svg')||figure()?.querySelector('svg'))?.cloneNode(true) as SVGElement | undefined;
   if(rider){rider.setAttribute('x','25');rider.setAttribute('y','6');rider.setAttribute('width','22');rider.setAttribute('height','29');
   picture.querySelector('svg')!.append(rider);}
  }
  const label=document.createElement('span');label.className='touch-label';label.textContent=touchLabel(kind);button.append(label);layer.append(button);
  if(old?.done)button.classList.add('touch-done');
  let replaying=false,drag=false,travel=0,start:[number,number]=[0,0];
  const onceSound=(cue:InteractionSound)=>{sound.play(cue,it.far ? .65 : 0,it.far ? .65 : 1);button.classList.remove('touch-react');void button.offsetWidth;button.classList.add('touch-react');};
  const complete=(cue:InteractionSound)=>{onceSound(cue);button.classList.add('touch-done');persist(it,{x:parseFloat(button.style.left),y:parseFloat(button.style.top),done:true});};
  const act=()=>{
   if(!active())return;
   if(kind==='recording'){replaying=!replaying;button.classList.toggle('touch-playing',replaying);if(replaying){sound.replay(pack().baseUrl+'audio/'+encodeURIComponent('风声')+'.mp3');note(lang==='en'?'A little wind, once more.':'再听一小段风声。');later(()=>{replaying=false;button.classList.remove('touch-playing');},4200);}else sound.stop();}
   else if(kind==='replay'){replaying=!replaying;if(replaying)playSceneAudio(sceneKey);else stopSpeech();button.classList.toggle('touch-playing',replaying);}
   else if(kind==='bell'){onceSound('bell');}
   else if(kind==='magnet'){complete('magnet');}
   else if(kind==='wire'){complete('connect');note(lang==='en'?'Connected. The light is on.':'接好了。灯亮了。');}
   else if(kind==='arms'){complete('arm');ripple(parseFloat(button.style.left),parseFloat(button.style.top));}
   else if(kind==='clean'){complete('wipe');for(let n=0;n<5;n++)later(()=>ripple((it.x??50)+(n-2)*3,(it.y??70)-n*2),n*60);}
   else if(kind==='seaweed'){button.style.left='79%';button.style.top='54%';complete('water');note(lang==='en'?'Softly placed.':'轻轻敷好了。');}
   else if(kind==='call'){onceSound('whale');ripple(it.x??50,it.y??50);}
   else if(kind==='boat'){button.style.left=Math.min(85,Math.max(15,parseFloat(button.style.left)+18))+'%';onceSound('water');}
   else {onceSound('scan');ripple(parseFloat(button.style.left),parseFloat(button.style.top));}
  };
  button.onclick=e=>{e.stopPropagation();if(travel>6){travel=0;return;}act();};
  const movable=['magnet','seaweed','boat','torch','room','wire','arms','clean'].includes(kind);
  if(movable){
   const target=document.createElement('i');if(kind==='wire'||kind==='seaweed'){target.className='touch-target';target.style.left=(kind==='wire'?77:79)+'%';target.style.top=(kind==='wire'?76:54)+'%';target.setAttribute('aria-hidden','true');layer.append(target);}
   button.addEventListener('pointerdown',e=>{if(!active())return;drag=true;travel=0;start=coords(e) as [number,number];button.setPointerCapture(e.pointerId);e.stopPropagation();e.preventDefault();},{signal:life.signal});
   button.addEventListener('pointermove',e=>{if(!drag||!active())return;const p=coords(e);travel=Math.max(travel,Math.hypot(p[0]-start[0],p[1]-start[1]));
    if(kind!=='clean'){button.style.left=p[0]+'%';button.style.top=p[1]+'%';}
    if(kind==='torch'||kind==='room'){illuminate(p[0],p[1]);if(kind==='torch')sound.play('propeller');}
    else if(kind==='clean')sound.play('wipe');else if(kind==='boat')sound.play('water');
   },{signal:life.signal});
   button.addEventListener('pointerup',()=>{if(!drag)return;drag=false;if(!active())return;
    if(kind==='wire'||kind==='seaweed'){const x=parseFloat(button.style.left),y=parseFloat(button.style.top),tx=kind==='wire'?77:79,ty=kind==='wire'?76:54;
     if(Math.hypot(x-tx,y-ty)<18){button.style.left=tx+'%';button.style.top=ty+'%';complete(kind==='wire'?'connect':'water');}else note(lang==='en'?'Try moving a little closer. You can also tap.':'再靠近一点，也可以轻点完成。');}
    else if(kind==='magnet'||kind==='arms'||kind==='clean')complete(kind==='magnet'?'magnet':kind==='arms'?'arm':'wipe');
    else persist(it,{x:parseFloat(button.style.left),y:parseFloat(button.style.top)});
   },{signal:life.signal});
   button.addEventListener('pointercancel',()=>{drag=false;travel=0;},{signal:life.signal});
  }
  if(kind==='room'||kind==='torch'){
   host.classList.add('touch-lit');const beam=document.createElement('div');beam.className='touch-beam';layer.prepend(beam);
   const focus=(e:PointerEvent)=>{if(!active()||e.target instanceof Element&&e.target.closest('.scene-touch'))return;const [x,y]=coords(e);host.style.setProperty('--touch-light-x',x+'%');host.style.setProperty('--touch-light-y',y+'%');
    if(kind==='room')illuminate(x,y);};
   host.addEventListener('pointerdown',focus,{signal:life.signal});host.addEventListener('pointermove',focus,{signal:life.signal});
  }
 }
 if(import.meta.env.DEV)Object.defineProperty(layer,'touchSnapshot',{get:()=>({sceneKey,sounds:sound.events})});
 return {cleanup(){if(disposed)return;disposed=true;life.abort();for(const t of timers)clearTimeout(t);sound.cleanup();layer.remove();host.classList.remove('has-touches','touch-lit');host.style.removeProperty('--touch-light-x');host.style.removeProperty('--touch-light-y');}};
}
