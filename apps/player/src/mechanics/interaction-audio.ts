import { soundEffectsOn } from '../sfx';
import { speechPref } from '../settings';
import { narrationHasFocus } from '../audioPriority';
export type InteractionSound='water'|'wipe'|'wind'|'propeller'|'splash'|'whale'|'bell'|'magnet'|'metal'|'arm'|'connect'|'scan'|'recorder'|'screen'|'door';
/** Quiet scene-owned effects. These never take narration focus or follow its on/off switch. */
export class InteractionAudio {
 private context?:AudioContext;private nodes=new Set<AudioScheduledSourceNode>();private media=new Set<HTMLAudioElement>();private lifetime=new AbortController();private disposed=false;private foreground=!document.hidden;private last=new Map<string,number>();
 readonly events:{kind:string;muted:boolean}[]=[];
 constructor(private active:()=>boolean=()=>true){
  const stop=()=>this.stop();
  document.addEventListener('taka-sfx-change',()=>{if(!soundEffectsOn())stop();},{signal:this.lifetime.signal});
  document.addEventListener('taka-volume-change',()=>{stop();},{signal:this.lifetime.signal});
  window.addEventListener('blur',()=>{this.foreground=false;stop();},{signal:this.lifetime.signal});
  window.addEventListener('focus',()=>{this.foreground=!document.hidden;},{signal:this.lifetime.signal});
  document.addEventListener('visibilitychange',()=>{this.foreground=!document.hidden;if(!this.foreground)stop();},{signal:this.lifetime.signal});
 }
 private allowed(){return !this.disposed&&this.foreground&&this.active()&&soundEffectsOn()&&speechPref.volume>0;}
 private ctx(){if(!this.allowed())return;try{const AC=window.AudioContext||window.webkitAudioContext;this.context??=new AC();void this.context.resume().catch(()=>{});return this.context;}catch{return;}}
 private keep(source:AudioScheduledSourceNode){this.nodes.add(source);source.onended=()=>{source.disconnect();this.nodes.delete(source);};}
 private level(){return speechPref.volume*(narrationHasFocus()? .1:.22);}
 private tone(f:number,d:number,g=.4,delay=0,type:OscillatorType='sine',end=f,pan=0){
  const c=this.ctx();if(!c||this.nodes.size>16)return;const o=c.createOscillator(),a=c.createGain(),p=c.createStereoPanner(),t=c.currentTime+delay+.006;
  o.type=type;o.frequency.setValueAtTime(f,t);o.frequency.exponentialRampToValueAtTime(Math.max(30,end),t+d);a.gain.setValueAtTime(.00001,t);a.gain.exponentialRampToValueAtTime(Math.max(.00002,g*this.level()),t+.012);a.gain.exponentialRampToValueAtTime(.00001,t+d);p.pan.value=pan;o.connect(a).connect(p).connect(c.destination);this.keep(o);o.start(t);o.stop(t+d+.02);o.onended=()=>{o.disconnect();a.disconnect();p.disconnect();this.nodes.delete(o);};
 }
 private noise(d:number,cutoff:number,g:number,delay=0){
  const c=this.ctx();if(!c||this.nodes.size>16)return;const buffer=c.createBuffer(1,Math.ceil(c.sampleRate*d),c.sampleRate),data=buffer.getChannelData(0);for(let i=0;i<data.length;i++)data[i]=(Math.random()*2-1)*(.7+.3*Math.sin(i/c.sampleRate*9));
  const s=c.createBufferSource(),f=c.createBiquadFilter(),a=c.createGain(),t=c.currentTime+delay;s.buffer=buffer;f.type='lowpass';f.frequency.value=cutoff;a.gain.setValueAtTime(.00001,t);a.gain.exponentialRampToValueAtTime(Math.max(.00002,g*this.level()),t+Math.min(.08,d*.15));a.gain.exponentialRampToValueAtTime(.00001,t+d);s.connect(f).connect(a).connect(c.destination);this.keep(s);s.onended=()=>{s.disconnect();f.disconnect();a.disconnect();this.nodes.delete(s);};s.start(t);s.stop(t+d+.01);
 }
 play(kind:InteractionSound,pan=0,strength=1){
  const at=performance.now();if(at-(this.last.get(kind)??-Infinity)<150)return;this.last.set(kind,at);this.events.push({kind,muted:!this.allowed()});if(this.events.length>40)this.events.shift();if(!this.allowed())return;
  const tone=(f:number,d:number,g=.4,delay=0,type:OscillatorType='sine',end=f)=>this.tone(f,d,g*strength,delay,type,end,pan);
  if(kind==='water'||kind==='wipe'){this.noise(.28,kind==='wipe'?1400:700,.22*strength);tone(430,.18,.15,0,'sine',170);}
  else if(kind==='wind')this.noise(.8,450+strength*2800,.25*strength);
  else if(kind==='propeller'){this.noise(.22,400,.16);tone(95,.2,.09,0,'triangle',110);}
  else if(kind==='splash'){this.noise(.65,2600,.5);tone(280,.3,.2,.03,'sine',80);}
  else if(kind==='whale'){for(let i=0;i<3;i++)tone(1250+i*130,.025,.35,i*.15,'sine',700);}
  else if(kind==='bell'){tone(1046,.85,.35);tone(2092,.4,.1,.01);tone(1450,.5,.1,.12);}
  else if(kind==='magnet'||kind==='connect'){tone(380,.09,.4,0,'triangle',280);tone(800,.23,.25,.07);if(kind==='connect')tone(1200,.35,.15,.16);}
  else if(kind==='arm'){tone(880,.6,.3);tone(1760,.25,.1);}
  else if(kind==='scan'){tone(520,.15,.25,0,'sine',780);tone(1040,.25,.2,.1);}
  else if(kind==='metal'||kind==='door'){tone(kind==='door'?170:300,.28,.4,0,'triangle',120);tone(680,.15,.15,.07);}
  else if(kind==='recorder'){tone(250,.06,.25,0,'square',160);this.noise(.45,900,.08,.06);}
  else if(kind==='screen'){this.noise(.35,2200,.08);tone(110,.2,.05);}
 }
 replay(url:string,seconds=4){
  this.stop();if(!this.allowed())return;
  const a=new Audio(url);a.volume=speechPref.volume*.45;a.playbackRate=1;this.media.add(a);
  a.ontimeupdate=()=>{if(a.currentTime>=seconds){a.pause();this.media.delete(a);}};
  a.onended=a.onerror=()=>{this.media.delete(a);};void a.play().catch(()=>this.media.delete(a));return a;
 }
 stop(){for(const n of this.nodes){try{n.stop();}catch{}}this.nodes.clear();for(const a of this.media){a.onended=a.onerror=a.ontimeupdate=null;a.pause();a.currentTime=0;}this.media.clear();}
 cleanup(){if(this.disposed)return;this.disposed=true;this.stop();this.lifetime.abort();void this.context?.close();}
}
