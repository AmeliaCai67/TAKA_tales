import {Lamp,Spin,CircleGesture,Rhythm,Ripples,defaults as smallDefaults,clamp} from './small-model.mjs';
import {Effects} from './small-sound.mjs';
import {View} from './small-view.mjs';
import {Maze,defaults as mazeDefaults,directionName,ActivityClock} from './maze-model.mjs';
import {MazeView} from './maze-view.mjs';
import {MazeAudio} from './maze-sound.mjs';
export class Stage{
 constructor(canvas,{hint,event,isActive,map,script,assetBase,soundAssets={},lang='zh'}){
  this.lifetime=new AbortController();
  Object.assign(this,{canvas,hint,event,isActive,script,assetBase,lang});this.config={...smallDefaults};this.mazeConfig={...mazeDefaults};
  this.effects=new Effects(this.config,soundAssets.laugh);this.audio=new MazeAudio(this.mazeConfig);this.view=new View(canvas,assetBase,lang);this.maze=new Maze(map);
  this.mode='story';this.scene='a';this.who='narrator';this.time=0;this.frameAt=performance.now();this.set('story');
  canvas.addEventListener('pointerdown',e=>this.down(e),{signal:this.lifetime.signal});canvas.addEventListener('pointermove',e=>this.move(e),{signal:this.lifetime.signal});canvas.addEventListener('pointerup',e=>this.up(e),{signal:this.lifetime.signal});
  for(const type of ['pointercancel','lostpointercapture'])canvas.addEventListener(type,e=>{if(this.pointer?.id===e.pointerId)this.stopMotion();},{signal:this.lifetime.signal});
  window.addEventListener('resize',()=>{this.stopMotion();this.view.resize();this.mazeView?.resize();},{signal:this.lifetime.signal});
  this.frame=this.frame.bind(this);this.raf=requestAnimationFrame(this.frame);
 }
 set(mode,scene=this.scene){
  this.stop();this.mode=mode;this.scene=scene;this.time=0;this.frameAt=performance.now();this.completed=false;this.fallSound=false;this.pickupEnabled=false;
  this.small={mode:mode==='g'||mode==='h'?'spin':mode,spinStage:mode,config:this.config,lamp:new Lamp(),spin:new Spin(this.config.maxSpin),rhythm:new Rhythm(this.config),ripples:new Ripples(),kicks:{},lastMaterial:null};
  if(mode==='maze'){
   this.mazeView??=new MazeView(this.canvas,this.maze,this.mazeConfig,this.assetBase,this.lang);this.mazeView.resize();this.clock=new ActivityClock();this.lastOtter=-10;this.lastStep=0;
   this.m={point:[...this.maze.start],phase:'playing',visited:new Set([this.maze.key(this.maze.start)]),visualTime:0,mapRemaining:0,hintRemaining:0,hintEdge:null,rippleRemaining:0,dragging:false,hasMoved:false,takeProgress:0,wallContact:false};
  }else{this.view.resize();if(mode==='h')void this.effects.preloadLaugh();}
 }
 stopMotion(){const id=this.pointer?.id;this.pointer=null;this.target=null;this.queue=[];if(this.m){this.m.dragging=false;this.m.wallContact=false;}if(id!=null)try{this.canvas.releasePointerCapture(id);}catch{}}
 stop(){this.stopMotion();this.effects.stop();this.audio.stop();}
 mute(value){this.effects.enabled=value;this.audio.setEnabled(value);if(!value)this.stop();}
 action(kind,arg){
  if(!this.isActive())return;
  const s=this.small;
  if(kind==='lamp'){s.lamp.set(arg);}
  else if(kind==='shell'||kind==='taka'){s.kicks[kind]=this.time;s.lastMaterial=kind;void this.effects.play(kind);this.hint(kind==='shell'?this.copy('贝壳 · 清亮的一声叮。','Shell · a clear ting.'):this.copy('铁皮 · 厚一点的金属碰撞声。','Metal · a deeper clank.'));}
  else if(kind==='boost'){s.spin.boost(this.time);void this.effects.play('water');}
  else if(kind==='stopSpin'){s.spin.stop();this.hint(this.copy('慢慢停下。想转的时候，再划一圈。','Slowly stopping. Draw another circle whenever you like.'));}
  else if(kind==='rhythm'){s.rhythm.start(this.time,!!arg);this.fallSound=false;void this.effects.unlock();}
  else if(kind==='tap'){
   const r=s.rhythm.tap(this.time);if(r.hit)void this.effects.play('hit');
   this.hint(r.hit?this.copy('跟上了！接着来。','On the beat! Keep going.'):this.copy('漏一拍也没关系，等光点再亮起来。','Missing a beat is fine. Wait for the light.'));
  }else if(kind==='ripple')this.ripple(.5,.55);
  else if(kind==='map'){this.m.mapRemaining=3;this.stopMotion();this.hint(this.copy('完整地图显示三秒。','The full map appears for three seconds.'));}
  else if(kind==='hint'){
   const a=this.maze.nodeOf(this.m.point),b=this.maze.hint(this.m.point);this.clock.invite();
   if(b){this.m.hintEdge={a,b};this.m.hintRemaining=2;const key=b[0]>a[0]?'right':b[0]<a[0]?'left':b[1]>a[1]?'down':'up';this.hint(`Daisy: ${this.script.hintDirections[key]}`);this.event('speech',{key:'maze-hint-'+key});}
  }else if(kind==='knock')this.knock();
  else if(kind==='take'&&this.m?.phase==='found'&&this.pickupEnabled){this.m.phase='taking';this.m.takeProgress=0;this.stopMotion();this.event('taking');}
  else if(kind==='dir')this.direction(...arg);
 }
 directionWord(a,b){return this.lang==='en'?(b[0]>a[0]?'right':b[0]<a[0]?'left':b[1]>a[1]?'down':'up'):directionName(a,b);}
 copy(zh,en){return this.lang==='en'?en:zh;}
 direction(dx,dy){
  if(this.mode!=='maze'||this.m.phase!=='playing')return;
  this.stopMotion();void this.audio.unlock();const a=this.maze.nodeOf(this.m.point),b=[a[0]+dx,a[1]+dy];
  if(!this.maze.neighbors(a).some(p=>this.maze.key(p)===this.maze.key(b))){this.wall();return;}
  this.queue=[[...a],b];this.target=this.queue.shift();
 }
 wall(){if(this.audio.wall(this.maze.wallFeedbackAt(this.m.point))){this.m.ripple=[...this.m.point];this.m.rippleRemaining=1;this.hint(this.maze.wallFeedbackAt(this.m.point).onMain?this.copy('清脆的叮 · 你在主路上。','A clear ting · on the main route.'):this.copy('闷闷的回响 · 这里是岔路。','A dull echo · a side passage.'));}}
 knock(selection){
  if(this.mode!=='maze'||this.m.phase!=='playing')return;
  void this.audio.unlock();const a=this.maze.nodeOf(this.m.point),options=this.maze.neighbors(a);
  if(!selection&&options.length>1){this.hint(this.copy('点塔卡身边的小圆环，选一条管道来听。','Tap a ring near TAKA to listen down that pipe.'));return;}
  const next=selection||options[0],echo=this.maze.echo(a,next);this.audio.knock(echo);
  this.m.ripple=[a[0]+(next[0]-a[0])*.48,a[1]+(next[1]-a[1])*.48];this.m.rippleRemaining=1.2;
  this.hint(`${this.directionWord(a,next)}: ${echo.correct?this.copy('回声里有一声细细的叮。','A tiny ting in the echo.'):this.copy('咚咚——空管道的回声。','Knock-knock · an empty pipe.')}`);
 }
 ripple(x,y){this.small.ripples.add(clamp(x,0,1),clamp(y,0,1),this.time);void this.effects.play('water');}
 down(e){
  if(e.button!==0||!this.isActive()||this.pointer)return;
  if(this.mode==='story')return;
  const {canvas,view}=this;void this.effects.unlock();
  if(this.mode==='maze'){
   void this.audio.unlock();const p=this.mazeView.world(e.clientX,e.clientY),m=this.m;
   if(m.phase==='found'){if(Math.hypot(p[0]-this.maze.goal[0],p[1]-this.maze.goal[1])<.5)this.pointer={id:e.pointerId,start:[e.clientX,e.clientY],travel:0,pickup:true};else return;}
   else if(m.phase==='playing'){
    const [x,y]=this.mazeView.client(m.point),drag=Math.hypot(x-e.clientX,y-e.clientY)<Math.max(28,this.mazeView.cell*.51);
    this.pointer={id:e.pointerId,start:[e.clientX,e.clientY],travel:0,drag,offset:[m.point[0]-p[0],m.point[1]-p[1]]};m.dragging=drag;
   }else return;
  }else{
   const p=view.point(e.clientX,e.clientY);
   this.pointer={id:e.pointerId,start:p,last:p,travel:0,level:this.small.lamp.target,lamp:this.mode==='lamp'&&view.hit('lampEye',p),gesture:new CircleGesture()};
   if(this.mode==='g'){const c=view.layout().otter;this.pointer.gesture.move((p[0]-c[0])/view.s,(p[1]-c[1])/view.s);}
   if(this.mode==='ripple')this.ripple(p[0]/view.w,p[1]/view.h);
  }
  canvas.setPointerCapture(e.pointerId);canvas.focus({preventScroll:true});e.preventDefault();
 }
 move(e){
  const p=this.pointer;if(!p||p.id!==e.pointerId||!this.isActive())return;
  const rect=this.canvas.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom){this.stopMotion();return;}
  if(this.mode==='maze'){
   p.travel=Math.max(p.travel,Math.hypot(e.clientX-p.start[0],e.clientY-p.start[1]));
   if(p.drag){const q=this.mazeView.world(e.clientX,e.clientY);this.target=[q[0]+p.offset[0],q[1]+p.offset[1]];}
  }else{
   const q=this.view.point(e.clientX,e.clientY);p.travel+=Math.hypot(q[0]-p.last[0],q[1]-p.last[1]);
   if(p.lamp)this.small.lamp.set(p.level+(p.start[1]-q[1])/(this.view.s*.32));
   if(this.mode==='g'){const c=this.view.layout().otter,arc=p.gesture.move((q[0]-c[0])/this.view.s,(q[1]-c[1])/this.view.s);this.small.spin.stroke(arc,this.time);}
   if(this.mode==='ripple'&&Math.hypot(q[0]-p.last[0],q[1]-p.last[1])>16){this.ripple(q[0]/this.view.w,q[1]/this.view.h);p.last=q;}
   else if(this.mode!=='ripple')p.last=q;
  }e.preventDefault();
 }
 up(e){
  if(!this.pointer||e.pointerId!==this.pointer.id)return;
  const saved=this.pointer;this.stopMotion();if(!this.isActive()||saved.travel>=8)return;
  if(this.mode==='maze'){
   if(saved.pickup){this.action('take');return;}
   if(saved.drag)return;
   const p=this.mazeView.world(e.clientX,e.clientY),a=this.maze.nodeOf(this.m.point);
   const options=this.maze.neighbors(a).map(b=>({b,d:Math.hypot(a[0]+(b[0]-a[0])*.48-p[0],a[1]+(b[1]-a[1])*.48-p[1])})).sort((a,b)=>a.d-b.d);
   if(options[0]?.d<.4)this.knock(options[0].b);else this.knock();return;
  }
  const p=this.view.point(e.clientX,e.clientY);
  if(this.mode==='lamp'&&saved.lamp)this.action('lamp',Math.min(1,this.small.lamp.target+.3));
  else if(this.mode==='material'){if(this.view.hit('shell',p))this.action('shell');else if(this.view.hit('metal',p))this.action('taka');}
  else if(this.mode==='g'&&this.view.hit('otter',p))this.action('stopSpin');
  else if(this.mode==='h'){if(this.small.rhythm.phase==='idle')this.action('rhythm',false);else this.action('tap');}
 }
 updateMaze(dt,elapsed){
  const m=this.m;m.visualTime=this.time;
  for(const k of ['mapRemaining','hintRemaining','rippleRemaining'])m[k]=Math.max(0,m[k]-elapsed);
  if(m.phase==='playing'){
   if(this.target){
    const [dx,dy]=[this.target[0]-m.point[0],this.target[1]-m.point[1]],d=Math.hypot(dx,dy),previous=[...m.point];
    if(d>.003){
     const step=Math.min(d,this.mazeConfig.speed*dt),r=this.maze.sweep(m.point,[m.point[0]+dx/d*step,m.point[1]+dy/d*step]);m.point=r.point;
     if(r.collided&&!m.wallContact)this.wall();m.wallContact=r.collided;
     const node=this.maze.nodeOf(m.point),key=this.maze.key(node);
     if(!m.visited.has(key)){m.visited.add(key);this.clock.progress();}
     if(Math.hypot(m.point[0]-previous[0],m.point[1]-previous[1])>.003){
      m.hasMoved=true;if(this.time-this.lastStep>.4){this.audio.step();this.lastStep=this.time;}
      const before=this.maze.distance(this.maze.nodeOf(previous)),dist=this.maze.distance(node);
      if(before!==dist&&this.time-this.lastOtter>8){const key=dist>before?'cold':dist<=3?'hot':'warm';this.hint(`${this.otterName||'小海獭'}：${this.script[key]}`);this.event('speech',{key:'maze-'+key});this.lastOtter=this.time;}
     }
     if(Math.hypot(m.point[0]-this.maze.goal[0],m.point[1]-this.maze.goal[1])<.24){m.phase='found';this.stopMotion();this.audio.found();this.event('found');}
    }else{this.target=this.queue.shift()||null;m.wallContact=false;}
   }
   this.clock.tick(elapsed);if(this.clock.due){this.clock.invite();this.event('invite');}
  }else if(m.phase==='taking'){m.takeProgress=Math.min(1,m.takeProgress+elapsed/.95);if(m.takeProgress>=1){m.phase='done';this.event('taken');}}
 }
 drawStory(){
  const v=this.view,c=v.ctx,{w,h,s}=v; c.setTransform(v.dpr,0,0,v.dpr,0,0);c.clearRect(0,0,w,h);v.water(this.time,['g','h','i','i1','i2','j'].includes(this.scene));
  const actors=this.scene==='a'&&(this.storyIndex||0)<2?['taka']:
   ['a','b','c','d','e'].includes(this.scene)||this.scene==='f'&&(this.storyIndex||0)<7?['taka','otter']:['taka','otter','rivet'];
  const xs=actors.length===1?[.5]:actors.length===2?[.31,.68]:[.22,.5,.78];
  for(let i=0;i<actors.length;i++){
   const actor=actors[i],x=w*xs[i],y=h*.53+Math.sin(this.time*.6+i)*s*.008,size=s*(actor==='rivet'?.29:actor==='otter'?.35:.39);
   if(this.who===actor){c.strokeStyle='#c4cbb046';c.lineWidth=1;c.beginPath();c.ellipse(x,y+s*.25,s*.18,s*.025,0,0,Math.PI*2);c.stroke();}
   v.sprite(actor,x,y,size,0,this.who==='narrator'||this.who===actor?1:.72);
   v.text(actor==='taka'?'塔卡':actor==='rivet'?'小钉':this.otterName||'小海獭',x,h*.79,12,'#b4c8cb');
  }
  if(this.scene==='j'){c.fillStyle='#07142168';c.fillRect(0,0,w,h);}
 }
 frame(at){
  const elapsed=Math.max(0,(at-this.frameAt)/1000),dt=Math.min(.12,elapsed);this.frameAt=at;
  if(this.isActive()){
   this.time+=elapsed;const s=this.small;
   if(this.mode==='lamp'&&s.lamp.tick(elapsed)){void this.effects.play('lamp');this.completed=true;this.event('lamp');}
   if(this.mode==='g')s.spin.tick(dt,this.time);
   if(this.mode==='h'){
    if(s.rhythm.tick(this.time))void this.effects.play('beat');
    if(s.rhythm.phase==='fall'&&!this.fallSound){this.fallSound=true;void this.effects.play('fall');this.hint(this.copy('啪嗒！哐当！','Clatter! Clang!'));this.event('speech',{key:'robot-fall'});}
    if(s.rhythm.phase==='done'&&!this.completed){this.completed=true;this.event('rhythm');}
    this.event('beat',s.rhythm);
   }
   s.ripples.tick(this.time);
   if(this.mode==='maze'){this.updateMaze(dt,elapsed);this.mazeView.draw(this.m);}
   else if(this.mode==='story')this.drawStory();else this.view.draw(s,this.time);
  }
  this.raf=requestAnimationFrame(this.frame);
 }
 cleanup(){this.lifetime.abort();cancelAnimationFrame(this.raf);this.stop();this.view.observer.disconnect();this.mazeView?.observer.disconnect();void this.effects.ctx?.close();void this.audio.context?.close();}
 snapshot(){return {mode:this.mode,scene:this.scene,time:this.time,completed:this.completed,dragging:!!this.pointer,lamp:{level:this.small.lamp.level,target:this.small.lamp.target,completed:this.small.lamp.completed},rhythm:{phase:this.small.rhythm.phase,count:this.small.rhythm.count,startAt:this.small.rhythm.startAt,interval:this.small.rhythm.interval,angle:this.small.rhythm.angle},spin:{speed:this.small.spin.speed,target:this.small.spin.target,angle:this.small.spin.angle},ripples:this.small.ripples.items.length,maze:this.m?{point:[...this.m.point],phase:this.m.phase,mapRemaining:this.m.mapRemaining,hintRemaining:this.m.hintRemaining,invited:this.clock.invited}:null,soundEvents:this.mode==='maze'?this.audio.events.slice():this.effects.events.slice()};}
 client(p){return this.mode==='maze'?this.mazeView.client(p):Array.isArray(p)?this.view.client([p[0]*this.view.w,p[1]*this.view.h]):this.view.client(this.view.layout()[p]);}
}
