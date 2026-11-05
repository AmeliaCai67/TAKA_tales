import {drawUprightActor,drawSpinWake} from './spin-draw.mjs';
const TAU=Math.PI*2;
export class View {
 constructor(canvas,assetBase,lang='zh'){this.lang=lang;this.canvas=canvas;this.ctx=canvas.getContext('2d');this.images={};for(const name of ['taka','otter','otter-floating','otter-face','rivet','shell']){const img=new Image();img.src=`${assetBase}${name}.svg`;this.images[name]=img;}this.resize();this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(canvas.parentElement);}
 copy(zh,en){return this.lang==='en'?en:zh;}
 resize(){const r=this.canvas.getBoundingClientRect();this.w=Math.max(1,r.width);this.h=Math.max(1,r.height);this.s=Math.min(this.w,this.h);this.dpr=Math.min(2,devicePixelRatio||1);this.canvas.width=Math.round(this.w*this.dpr);this.canvas.height=Math.round(this.h*this.dpr);}
 layout(){const{w,h,s}=this;return {lampTaka:[w*.28,h*.59],lampEye:[w*.28,h*.59-s*.049],shell:[w*.32,h*.53],metal:[w*.72,h*.53],otter:[w*.5,h*.48]};}
 point(clientX,clientY){const r=this.canvas.getBoundingClientRect();return [clientX-r.left,clientY-r.top];}
 client(p){const r=this.canvas.getBoundingClientRect();return [r.left+p[0],r.top+p[1]];}
 hit(name,p){const a=this.layout()[name],radius=this.s*(name==='lampEye'?.14:name==='shell'?.18:name==='otter'?.23:.24);return !!a&&Math.hypot(a[0]-p[0],a[1]-p[1])<=radius;}
 text(text,x,y,size=11,color='#94b3bf',align='center'){const c=this.ctx;c.font=`${size}px "PingFang SC","Microsoft YaHei",sans-serif`;c.textAlign=align;c.fillStyle=color;c.fillText(text,x,y);}
 sprite(name,x,y,size,angle=0,alpha=1){const c=this.ctx,img=this.images[name];c.save();c.translate(x,y);c.rotate(angle);c.globalAlpha=alpha;c.imageSmoothingEnabled=true;if(img?.complete&&img.naturalWidth){const height=size*img.naturalHeight/img.naturalWidth;c.drawImage(img,-size/2,-height/2,size,height);}c.restore();}
 yawSprite(name,x,y,size,angle=0){drawUprightActor(this,name,x,y,size,angle);}
 water(time,warm=false){const c=this.ctx,{w,h,s}=this;const sky=c.createLinearGradient(0,0,w*.3,h);sky.addColorStop(0,warm?'#8d826329':'#17415344');sky.addColorStop(.5,warm?'#48626330':'#113e4e30');sky.addColorStop(1,warm?'#183f4c60':'#071e2c22');c.fillStyle=sky;c.fillRect(0,0,w,h);c.lineWidth=.7;
 for(let n=0;n<17;n++){const y=h*(.12+n*.05);c.strokeStyle=warm?`rgba(209,196,159,${.025+(n%3)*.01})`:`rgba(152,201,210,${.025+(n%3)*.007})`;c.beginPath();for(let x=0;x<w+10;x+=10){const yy=y+Math.sin(x/(s*.38)+time*.18+n)*s*.008;if(!x)c.moveTo(x,yy);else c.lineTo(x,yy);}c.stroke();}
 if(!warm)for(let n=0;n<22;n++){const x=(n*131.37)%w,y=((n*83.61-time*(2+n%4))%h+h)%h;c.fillStyle='#c5dee91c';c.beginPath();c.arc(x,y,n%4===0?1.2:.6,0,TAU);c.fill();}
 }
 draw(state,now){const c=this.ctx,{w,h,s}=this;c.setTransform(this.dpr,0,0,this.dpr,0,0);c.clearRect(0,0,w,h);this.water(now,state.mode==='ripple');if(state.mode==='lamp')this.lamp(state,now);else if(state.mode==='material')this.material(state,now);else if(state.mode==='spin')this.spin(state,now);else this.ripples(state,now);}
 lamp(state,now){const c=this.ctx,{w,h,s}=this,{lampTaka:t,lampEye:e}=this.layout(),level=state.lamp.level;
 // Cold glass catches the beam; the surface stays translucent at full brightness.
 const paths=[[[.48,.27],[.69,.27],[.69,.45],[.91,.45]],[[.52,.72],[.52,.54],[.82,.54],[.82,.75]],[[.73,.18],[.89,.18],[.89,.32]]];
 for(const path of paths){c.beginPath();path.forEach(([x,y],i)=>i?c.lineTo(x*w,y*h):c.moveTo(x*w,y*h));c.lineJoin='round';c.lineCap='round';c.lineWidth=s*.065;c.strokeStyle=`rgba(180,222,226,${.012+level*.035})`;c.stroke();c.lineWidth=1.2;c.strokeStyle=`rgba(182,229,236,${.025+level*.48})`;c.stroke();}
 const beam=c.createRadialGradient(...e,0,...e,s*(.35+level*1.25));beam.addColorStop(0,`rgba(201,225,220,${level*.10})`);beam.addColorStop(1,'#c9e1dc00');c.fillStyle=beam;c.beginPath();c.moveTo(...e);c.lineTo(w*.97,h*.11);c.quadraticCurveTo(w*1.15,h*.52,w*.97,h*.91);c.closePath();c.fill();
 const halo=c.createRadialGradient(...e,0,...e,s*.22);halo.addColorStop(0,`rgba(230,192,108,${.08+level*.21})`);halo.addColorStop(1,'#e6c06c00');c.fillStyle=halo;c.fillRect(e[0]-s*.25,e[1]-s*.25,s*.5,s*.5);
 this.sprite('taka',...t,s*.6);
 this.sprite('otter',w*.77,h*.65,s*.21);
 c.fillStyle=`rgba(18,40,49,${(1-level)*.88})`;c.beginPath();c.ellipse(e[0],e[1],s*.039,s*.039,0,0,TAU);c.fill();
 this.text(this.copy("塔卡","TAKA"),t[0],t[1]+s*.37,10);
 if(!state.lamp.completed){c.save();c.setLineDash([3,7]);c.strokeStyle='#c9c5a477';c.lineWidth=1;c.beginPath();c.moveTo(e[0],e[1]-s*.13);c.lineTo(e[0],e[1]-s*.36);c.stroke();c.setLineDash([]);c.beginPath();c.moveTo(e[0]-5,e[1]-s*.32);c.lineTo(e[0],e[1]-s*.36);c.lineTo(e[0]+5,e[1]-s*.32);c.stroke();c.restore();this.text(this.copy("往上拖","Slide up"),e[0]+s*.11,e[1]-s*.24,10,'#b4c3be');}
 if(!state.registration)this.text(state.lamp.completed?this.copy("灯亮了，维修管道亮起来了。","The light came on. The pipes lit up."):this.copy("灯光照到哪里，管道就显出轮廓。","The light reveals the pipes."),w*.61,h*.9,Math.max(10,s*.024),state.lamp.completed?'#bfd5d5':'#5e8799');
 }
 material(state,now){const c=this.ctx,{w,h,s}=this,{shell:a,metal:b}=this.layout();
 for(const p of [a,b]){c.strokeStyle='#a9c7c31c';c.lineWidth=1;c.beginPath();c.ellipse(p[0],p[1]+s*.32,s*.20,s*.035,0,0,TAU);c.stroke();}
 const kick=which=>{const age=now-(state.kicks[which]??-10);return age<.6?Math.sin(age*35)*Math.exp(-age*8)*s*.023:0;};
 this.sprite('shell',a[0],a[1]+kick('shell'),s*.28);this.sprite('taka',b[0]+kick('taka'),b[1],s*.54);
 this.text(this.copy("贝壳","Shell"),a[0],a[1]+s*.43,12,'#d1c7aa');this.text(this.copy("塔卡的铁皮","TAKA's metal shell"),b[0],b[1]+s*.43,12);this.text(this.copy("轻点","Tap"),a[0],a[1]-s*.27,9,'#6e929e');this.text(this.copy("轻点","Tap"),b[0],b[1]-s*.33,9,'#6e929e');
 if(state.lastMaterial){const p=state.lastMaterial==='shell'?a:b,age=now-state.kicks[state.lastMaterial];if(age<.65){c.strokeStyle=`rgba(193,221,214,${(.65-age)*.6})`;c.lineWidth=1;c.beginPath();c.ellipse(p[0],p[1],s*(.17+age*.2),s*(.13+age*.15),0,0,TAU);c.stroke();}}
 this.text(this.copy("点一下，听听两种不一样的声音。","Tap and listen to the two sounds."),w*.5,h*.16,11,'#789da9');
 }
 spin(state,now){const c=this.ctx,{w,h,s}=this;
 const rock=(x,y,size)=>{c.fillStyle='#203c46';c.beginPath();c.moveTo(x-size*.7,y+size*.22);c.lineTo(x-size*.48,y-size*.13);c.quadraticCurveTo(x+size*.15,y-size*.42,x+size*.65,y);c.lineTo(x+size*.77,y+size*.25);c.closePath();c.fill();c.strokeStyle='#6e929838';c.lineWidth=1;c.stroke();};
 rock(w*(state.spinStage==='h'?.60:.86),h*(state.spinStage==='h'?.74:.71),s*(state.spinStage==='h'?.22:.24));
 if(state.spinStage==='g'){const p=this.layout().otter;const ratio=state.spin.speed/state.config.maxSpin;c.strokeStyle='#b4d3cd22';c.lineWidth=1;c.beginPath();c.ellipse(p[0],p[1]+s*.18,s*(.22+ratio*.025),s*.045,0,0,TAU);c.stroke();drawSpinWake(this,p[0],p[1]+s*.21,s*.58,state.spin.angle,state.spin.speed);this.yawSprite('otter',p[0],p[1],s*.58,state.spin.angle);this.sprite('taka',w*.15,h*.73,s*.21);this.sprite('rivet',w*.83,h*.69,s*.20);this.text(this.copy("沿着小海獭周围划个圈","Draw a circle around the little otter"),p[0],h*.15,11,'#90adb4');this.text(this.copy("轻点小海獭，让它慢慢停下","Tap the little otter to slow it down"),p[0],h*.87,10,'#7095a1');}
 else{const rhythm=state.rhythm,fall=rhythm.phase==='fall'||rhythm.phase==='done',t=fall?Math.min(1,(now-rhythm.fallAt)/1.2):0;
 const easing=t*t*(3-2*t),wobble=fall?Math.sin(t*14)*(1-t)*.3:0,angle=rhythm.angle||0,x1=w*(.34+easing*.17),x2=w*(.71-easing*.09),y1=h*(.48+easing*.23),y2=h*(.48+easing*.15);
 if(fall){this.sprite('taka',x1,y1,s*.38,easing*1.25+wobble);this.sprite('rivet',x2,y2,s*.32,-easing*1.15-wobble);}
 else{drawSpinWake(this,x1,y1+s*.2,s*.5,angle);drawSpinWake(this,x2,y2+s*.2,s*.46,-angle);this.yawSprite('taka',x1,y1,s*.5,angle);this.yawSprite('rivet',x2,y2,s*.46,-angle);}
 this.sprite('otter-floating',w*.18,h*.76,s*.30);
 if(rhythm.phase==='playing'){const phase=rhythm.beatPhase(now);const r=s*(.075+(1-phase)*.03);c.strokeStyle=`rgba(209,206,176,${.2+(1-phase)*.4})`;c.lineWidth=1.2;c.beginPath();c.arc(w*.52,h*.18,r,0,TAU);c.stroke();c.fillStyle='#c4d2bc';c.beginPath();c.arc(w*.52,h*.18,s*.012,0,TAU);c.fill();}
 if(fall)this.text(this.copy("啪嗒！哐当！","Clatter! Clang!"),w*.53,h*.34,Math.max(16,s*.045),'#c8c7ae');else this.text(rhythm.phase==='idle'?this.copy("塔卡和小钉也来试试。","TAKA and Rivet try a spin too."):this.copy("跟着拍子，一起转起来。","Spin together, on the beat."),w*.51,h*.88,11,'#8caab6');
 }
 }
 ripples(state,now){const c=this.ctx,{w,h,s}=this;const sun=c.createRadialGradient(w*.67,-s*.08,0,w*.67,-s*.08,s*.9);sun.addColorStop(0,'#e7ce9e22');sun.addColorStop(1,'#e7ce9e00');c.fillStyle=sun;c.fillRect(0,0,w,h);
 c.fillStyle='#25414a';c.beginPath();c.moveTo(w*.67,h*.07);c.quadraticCurveTo(w*.85,-h*.05,w,h*.17);c.lineTo(w,h*.27);c.quadraticCurveTo(w*.82,h*.16,w*.67,h*.07);c.fill();this.sprite('taka',w*.80,h*.11,s*.12,-.1,.6);this.sprite('rivet',w*.93,h*.15,s*.115,.12,.6);this.sprite('otter-floating',w*.63,h*.23,s*.25,0,.9);
 const colors=['188,208,194','196,184,209','185,212,219','221,198,165','185,205,213'];
 for(const r of state.ripples.items){const age=now-r.born,p=age/2.8,x=r.x*w,y=r.y*h,alpha=(1-p)*Math.min(1,age*7)*.65,radius=s*(.025+p*.24);c.lineWidth=1.2;c.strokeStyle=`rgba(${colors[r.id%colors.length]},${alpha})`;c.beginPath();c.ellipse(x,y,radius,radius*.48,0,0,TAU);c.stroke();c.strokeStyle=`rgba(${colors[r.id%colors.length]},${alpha*.35})`;c.lineWidth=.8;c.beginPath();c.ellipse(x,y,radius*.72,radius*.34,0,0,TAU);c.stroke();}
 if(!state.ripples.serial){this.text(this.copy("轻轻碰一下水面。","Gently touch the water."),w*.5,h*.48,Math.max(13,s*.034),'#b8c6be');this.text(this.copy("这一圈，会慢慢散开。","Watch the ripple slowly spread."),w*.5,h*.55,10,'#789da9');}
 }
}
