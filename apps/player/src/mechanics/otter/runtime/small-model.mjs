export const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
export const defaults = Object.freeze({maxSpin:1, bpm:60, hits:8, window:.4, volume:.65});
export class Lamp {
 level=.12; target=.12; completed=false; completions=0;
 set(value) { this.target=clamp(value,0,1); }
 tick(dt) {
  this.level += (this.target-this.level)*(1-Math.exp(-Math.max(0,dt)*10));
  if (this.level>=.96 && !this.completed) {this.completed=true;this.completions++;return true;}
  return false;
 }
}
export class CircleGesture {
 last=null;
 move(x,y) {
  const radius=Math.hypot(x,y);
  if(radius<.08||radius>.65){this.last=null;return 0;}
  const angle=Math.atan2(y,x), previous=this.last;this.last=angle;
  if(previous===null)return 0;
  const delta=Math.atan2(Math.sin(angle-previous),Math.cos(angle-previous));
  return Math.abs(delta)<1.05?Math.abs(delta):0;
 }
}
export class Spin {
 speed=.32;target=.32;angle=0;lastStroke=0;resting=false;arc=0;
 constructor(max=1){this.max=max;}
 stroke(arc,now) {if(!arc)return;this.resting=false;this.lastStroke=now;this.arc+=arc;this.target=clamp(this.target+arc*.15,.32,this.max);}
 boost(now){this.stroke(2,now);}
 stop(){this.resting=true;this.target=0;}
 tick(dt,now){if(!this.resting&&now-this.lastStroke>1.5)this.target=Math.min(this.target,.32);this.speed+=(this.target-this.speed)*(1-Math.exp(-Math.max(0,dt)*9));if(this.resting&&this.speed<.003)this.speed=0;this.angle=(this.angle+this.speed*dt*Math.PI*2)%(Math.PI*2);}
}
export class Rhythm {
 phase='idle'; count=0; lastBeat=-1; hitBeats=new Set(); completions=0; auto=false; angle=0; lastTime=0;
 constructor({bpm=60,hits=8,window=.4}={}){this.bpm=bpm;this.required=hits;this.window=window;}
 start(now,auto=false){this.phase='playing';this.count=0;this.hitBeats.clear();this.startAt=now+.75;this.lastBeat=-1;this.auto=auto;this.completions=0;this.angle=0;this.lastTime=now;}
 get interval(){return 60/this.bpm;}
 beatPhase(now){return ((now-this.startAt)/this.interval%1+1)%1;}
 tap(now){
  if(this.phase!=='playing')return {hit:false,reason:'idle'};
  const beat=Math.round((now-this.startAt)/this.interval), offset=Math.abs(now-(this.startAt+beat*this.interval));
  if(beat<0||offset>this.window)return {hit:false,reason:'offbeat'};
  if(this.hitBeats.has(beat))return {hit:false,reason:'repeat'};
  this.hitBeats.add(beat);this.count++;
  if(this.count>=this.required){this.phase='fall';this.fallAt=now;this.completions++;}
  return {hit:true,finished:this.phase==='fall'};
 }
 tick(now){
  if(this.phase==='playing')this.angle=(this.angle+Math.max(0,now-this.lastTime)*(.24+this.count/this.required*.62)*Math.PI*2)%(Math.PI*2);
  this.lastTime=now;
  if(this.phase==='fall'&&now-this.fallAt>=1.6)this.phase='done';
  if(this.phase!=='playing')return false;
  const beat=Math.floor((now-this.startAt)/this.interval);
  if(beat>=0&&beat>this.lastBeat){this.lastBeat=beat;if(this.auto)this.tap(this.startAt+beat*this.interval);return true;}
  return false;
 }
}
export class Ripples {
 items=[];serial=0;
 add(x,y,now){this.tick(now);this.items.push({x,y,born:now,id:this.serial++});if(this.items.length>5)this.items.shift();}
 tick(now){this.items=this.items.filter(r=>now-r.born<2.8);}
}
