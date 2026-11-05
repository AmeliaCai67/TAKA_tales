export class Effects {
 enabled=true;nodes=new Set();events=[];generation=0;last=new Map();
 constructor(config,laughUrl){this.config=config;this.laughUrl=laughUrl;}
 preloadLaugh(){if(!this.laughUrl)return Promise.resolve(null);return this.laughBytes??=fetch(this.laughUrl).then(r=>r.ok?r.arrayBuffer():null).catch(()=>{this.laughBytes=null;return null;});}
 async laugh(generation,after){
  try{
   const bytes=await this.preloadLaugh();if(!bytes||!this.ctx||generation!==this.generation||!this.enabled)return;
   const buffer=await this.ctx.decodeAudioData(bytes.slice(0));
   if(generation!==this.generation||!this.enabled||!this.config.volume)return;
   const ctx=this.ctx,osc=ctx.createBufferSource(),amp=ctx.createGain(),at=Math.max(ctx.currentTime+.01,after);
   osc.buffer=buffer;amp.gain.value=this.config.volume*.52;osc.connect(amp);amp.connect(ctx.destination);
   const entry={osc,amp};this.nodes.add(entry);osc.onended=()=>{this.nodes.delete(entry);osc.disconnect();amp.disconnect();};
   this.events.push({kind:'laugh',muted:false,at:performance.now(),delay:at-ctx.currentTime});osc.start(at);
  }catch{/* A missing decorative sound never blocks the story. */}
 }
 async unlock(){try{const C=window.AudioContext||window.webkitAudioContext;this.ctx??=new C();await this.ctx.resume();return this.ctx.state==='running';}catch{return false;}}
 tone(frequency,duration,gain,type='sine',end=frequency,delay=0){
  if(!this.ctx||!this.enabled||this.nodes.size>=30)return;
  const ctx=this.ctx,osc=ctx.createOscillator(),amp=ctx.createGain(),at=ctx.currentTime+delay+.008;
  osc.type=type;osc.frequency.setValueAtTime(frequency,at);osc.frequency.exponentialRampToValueAtTime(Math.max(30,end),at+duration);
  amp.gain.setValueAtTime(0,at);amp.gain.linearRampToValueAtTime(gain*this.config.volume*.45,at+.006);amp.gain.exponentialRampToValueAtTime(.00001,at+duration);
  osc.connect(amp);amp.connect(ctx.destination);const entry={osc,amp};this.nodes.add(entry);
  osc.onended=()=>{this.nodes.delete(entry);osc.disconnect();amp.disconnect();};osc.start(at);osc.stop(at+duration+.02);
 }
 async play(kind){
  const now=performance.now();if(now-(this.last.get(kind)??-Infinity)<(kind==='water'?150:100))return;
  this.last.set(kind,now);const generation=this.generation;
  this.events.push({kind,muted:!this.enabled||!this.config.volume,at:now});if(this.events.length>80)this.events.shift();
  if(!this.enabled||!this.config.volume||!await this.unlock()||generation!==this.generation)return;
  if(kind==='shell'||kind==='taka')this.clear();
  if(kind==='shell'){this.tone(1560,.55,.35);this.tone(2495,.26,.12);this.tone(3740,.12,.06);}
  else if(kind==='taka'){this.tone(310,.24,.4,'triangle',240);this.tone(710,.16,.18,'sine',670);this.tone(1040,.08,.07);}
  else if(kind==='lamp'){this.tone(440,.13,.12,'sine',660);this.tone(880,.3,.13,'sine',880,.08);}
  else if(kind==='water'){this.tone(580,.11,.08,'sine',160);this.tone(940,.075,.04,'sine',420,.035);}
  else if(kind==='beat'){this.tone(570,.065,.14,'sine',480);}
  else if(kind==='hit'){this.tone(850,.09,.12,'sine',910);}
  else if(kind==='fall'){this.tone(210,.14,.3,'triangle',95,.28);this.tone(130,.26,.35,'triangle',68,.63);this.tone(590,.23,.12,'sine',300,.65);void this.laugh(generation,this.ctx.currentTime+.95);}
 }
 clear(){for(const entry of this.nodes){try{entry.amp.gain.cancelScheduledValues(0);entry.amp.gain.value=0;entry.osc.stop();}catch{}}this.nodes.clear();}
 stop(){this.generation++;this.clear();}
 mute(){this.enabled=!this.enabled;if(!this.enabled)this.stop();}
}
