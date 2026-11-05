// Small, dependency-free 3D meshes rendered into the activity's existing canvas.
// Only each robot's front panel uses the approved artwork. Limbs, sides and backs
// are volumes, so a quarter turn never squeezes the entire actor into a card.
const TAU=Math.PI*2;
export function projectYaw(x,y,z,angle){
 const c=Math.cos(angle),s=Math.sin(angle);
 return {x:x*c+z*s,y,depth:-x*s+z*c};
}
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const unit=a=>{const d=Math.hypot(...a)||1;return a.map(v=>v/d);};
const color=hex=>hex.match(/[\da-f]{2}/gi).map(v=>parseInt(v,16));
function surface(m,points,paint,origin=[0,0,0],texture=null){
 let n=unit(cross(sub(points[1],points[0]),sub(points[2],points[0])));
 const centre=points[0].map((_,i)=>points.reduce((s,p)=>s+p[i],0)/points.length);
 if(dot(n,sub(centre,origin))<0){points=[...points].reverse();n=n.map(v=>-v);}
 m.push({points,normal:n,paint:color(paint),texture});
}
function ellipsoid(m,centre,radii,paint,segments=16,rings=9){
 const p=(i,j)=>{const a=i*TAU/segments,b=-Math.PI/2+j*Math.PI/rings;return [centre[0]+radii[0]*Math.cos(a)*Math.cos(b),centre[1]+radii[1]*Math.sin(b),centre[2]+radii[2]*Math.sin(a)*Math.cos(b)];};
 for(let j=0;j<rings;j++)for(let i=0;i<segments;i++){
  // Triangles at the poles avoid degenerate normals.
  const points=j===0?[p(i,0),p(i+1,1),p(i,1)]:j===rings-1?[p(i,j),p(i+1,j),p(i,rings)]:[p(i,j),p(i+1,j),p(i+1,j+1),p(i,j+1)];
  surface(m,points,paint,centre);
 }
}
function box(m,centre,radii,paint,bevel=0){
 const [x,y,z]=centre,[w,h,d]=radii;
 // Rounded octagonal outline, extruded as a solid metal housing.
 const b=Math.min(bevel,w,h),outline=[[-w+b,-h],[w-b,-h],[w,-h+b],[w,h-b],[w-b,h],[-w+b,h],[-w,h-b],[-w,-h+b]];
 const ring=zz=>outline.map(([xx,yy])=>[x+xx,y+yy,z+zz]);
 const front=ring(d),back=ring(-d);
 surface(m,front,paint,centre);surface(m,back,paint,centre);
 for(let i=0;i<8;i++)surface(m,[front[i],back[i],back[(i+1)%8],front[(i+1)%8]],paint,centre);
}
function rod(m,a,b,r,paint){
 const direction=unit(sub(b,a)),u=unit(cross(direction,Math.abs(direction[1])>.9?[1,0,0]:[0,1,0])),v=cross(direction,u);
 const ring=(point,i)=>point.map((n,k)=>n+r*(u[k]*Math.cos(i*TAU/8)+v[k]*Math.sin(i*TAU/8)));
 for(let i=0;i<8;i++)surface(m,[ring(a,i),ring(b,i),ring(b,i+1),ring(a,i+1)],paint,a.map((x,k)=>(x+b[k])/2));
}
function robot(name){
 const m=[],taka=name==='taka',w=taka?50:48,top=taka?-60:-84,bottom=taka?42:56,depth=27;
 box(m,[0,(top+bottom)/2,0],[w,(bottom-top)/2,depth],'#6a8490',9);
 // The front has the exact round camera, fasteners and indicator/display from the reader.
 const mask=[[-w+9,top],[w-9,top],[w,top+9],[w,bottom-9],[w-9,bottom],[-w+9,bottom],[-w,bottom-9],[-w,top+9]].map(([x,y])=>[x,y,depth+.3]);
 m.push({mask,points:[[-w,top,depth+.3],[w,top,depth+.3],[w,bottom,depth+.3],[-w,bottom,depth+.3]],normal:[0,0,1],paint:color('#708b96'),texture:taka?[60/220,45/210,100/220,102/210]:[72/220,36/240,96/220,140/240]});
 for(const sign of [-1,1]){
  const armY=taka?7:0;
  for(let n=0;n<6;n++){
   const a=[sign*(w+3+n*4),armY+n*6,2];
   ellipsoid(m,a,[4.5,4,5],'#849aa3',8,5);
  }
  const claw=[sign*(w+26),armY+36,2];
  for(const fork of [-1,1])rod(m,claw,[claw[0]+sign*9,claw[1]+7,claw[2]+fork*7],2.3,'#354e59');
  const footX=sign*(taka?25:36),footY=taka?64:75;
  box(m,[footX,bottom+8,0],[taka?6:4,11,7],'#526e7b',2);
  ellipsoid(m,[footX,footY,5],[taka?13:9,taka?4:9,11],'#344b57',12,7);
 }
 if(taka){
  // A four-bladed rear propeller is visible only when TAKA turns away.
  ellipsoid(m,[0,-7,-31],[22,22,5],'#293f49',20,10);
  for(let i=0;i<4;i++){
   const a=i*Math.PI/2+.35,dx=Math.cos(a),dy=Math.sin(a);
   const points=[[0,-7,-37],[dx*18-dy*5,-7+dy*18+dx*5,-37],[dx*20+dy*5,-7+dy*20-dx*5,-37],[dx*6+dy*4,-7+dy*6-dx*4,-37]];
   surface(m,points,'#8ba4ad',[0,-7,0]);
  }
  ellipsoid(m,[0,-7,-39],[5,5,3],'#597a8b',10,6);
 }else{
  for(let n=0;n<5;n++)box(m,[0,-27+n*13,-28],[29,1.4,1.2],'#293f49');
 }
 // Recessed vents belong to each side; no strokes cross the front artwork.
 for(const sign of [-1,1])for(let n=0;n<4;n++)box(m,[sign*(w+.25),-20+n*12,-2],[.6,1,14],'#344d58');
 return m;
}
function otter(){
 const m=[];
 ellipsoid(m,[18,69,-29],[18,9,39],'#766e61');
 ellipsoid(m,[0,24,0],[43,54,33],'#8b7865',24,14);
 ellipsoid(m,[0,29,27],[30,41,10],'#ae9e83',20,12);
 for(const sign of [-1,1]){
  ellipsoid(m,[sign*28,77,8],[20,8,15],'#857864');
  ellipsoid(m,[sign*35,-67,0],[14,14,10],'#91816d');
  ellipsoid(m,[sign*35,-67,8],[8,8,4],'#c4b799',12,8);
 }
 ellipsoid(m,[0,-42,0],[47,39,35],'#a29178',28,16);
 // Front artwork comes from the approved smiling head; the surrounding head,
 // body, ears, paws and shell keep their depth throughout the turn.
 const headMask=Array.from({length:24},(_,i)=>{const a=i*TAU/24;return [48*Math.cos(a),-43+41*Math.sin(a),40];});
 m.push({mask:headMask,points:[[-48,-84,40],[48,-84,40],[48,-2,40],[-48,-2,40]],normal:[0,0,1],paint:color('#a29178'),texture:[0,0,1,1],textureImage:'otter-face'});
 for(const sign of [-1,1]){
  ellipsoid(m,[sign*34,28,17],[12,25,14],'#8b7865');
 }
 // A shallow fan shell is held in front of the belly with real thickness.
 const fan=[[-20,17,36],[-18,8,35],[-9,4,36],[0,8,37],[9,4,36],[18,8,35],[20,17,36],[0,43,43]];
 surface(m,fan,'#cbdacf',[0,22,0]);
 surface(m,fan.map(([x,y,z])=>[x,y,z-3]),'#9db7b2',[0,22,70]);
 for(const x of [-12,0,12])rod(m,[x,12,38],[0,40,44],.65,'#8daead');
 return m;
}
const models=new Map();
function camera(v,angle){const q=projectYaw(...v,angle);return [q.x,q.y*.992-q.depth*.126,q.depth*.992+q.y*.126];}
export function projectActorPoint(v,angle){const q=camera(v,angle),k=650/(650-q[2]);return {x:q[0]*k,y:q[1]*k,depth:q[2]};}
function triangle(c,img,src,dst){
 const [a,b,d]=src,[p,q,r]=dst,den=(b[0]-a[0])*(d[1]-a[1])-(d[0]-a[0])*(b[1]-a[1]);if(Math.abs(den)<1e-6)return;
 const u=[(q.x-p.x)*(d[1]-a[1])-(r.x-p.x)*(b[1]-a[1]),(q.y-p.y)*(d[1]-a[1])-(r.y-p.y)*(b[1]-a[1])].map(x=>x/den);
 const v=[(r.x-p.x)*(b[0]-a[0])-(q.x-p.x)*(d[0]-a[0]),(r.y-p.y)*(b[0]-a[0])-(q.y-p.y)*(d[0]-a[0])].map(x=>x/den);
 c.save();c.beginPath();c.moveTo(p.x,p.y);c.lineTo(q.x,q.y);c.lineTo(r.x,r.y);c.closePath();c.clip();c.transform(u[0],u[1],v[0],v[1],p.x-u[0]*a[0]-v[0]*a[1],p.y-u[1]*a[0]-v[1]*a[1]);c.drawImage(img,0,0,img.naturalWidth,img.naturalHeight);c.restore();
}
export function drawUprightActor(view,name,x,y,size,angle){
 if(!models.has(name))models.set(name,name==='otter'?otter():robot(name));
 const c=view.ctx,light=unit([-.5,-.65,.8]);
 const faces=models.get(name).map(face=>{
  const points=face.points.map(p=>projectActorPoint(p,angle)),normal=camera(face.normal,angle);
  return {...face,points,mask:face.mask?.map(p=>projectActorPoint(p,angle)),normal,depth:points.reduce((sum,p)=>sum+p.depth,0)/points.length};
 }).filter(f=>f.normal[2]>.005).sort((a,b)=>a.depth-b.depth);
 c.save();c.translate(x,y);c.scale(size/220,size/220);c.imageSmoothingEnabled=true;
 for(const face of faces){
  const img=view.images[face.textureImage||name];
  const shade=.63+Math.max(0,dot(face.normal,light))*.45;
  c.fillStyle=`rgb(${face.paint.map(v=>Math.min(255,Math.round(v*shade))).join(',')})`;
  c.beginPath();(face.mask||face.points).forEach((p,i)=>i?c.lineTo(p.x,p.y):c.moveTo(p.x,p.y));c.closePath();c.fill();
  if(face.texture&&img?.complete&&img.naturalWidth){
   const [u,v,w,h]=face.texture,iw=img.naturalWidth,ih=img.naturalHeight;
   const src=[[u*iw,v*ih],[(u+w)*iw,v*ih],[(u+w)*iw,(v+h)*ih],[u*iw,(v+h)*ih]];
   c.save();c.clip();for(const ids of [[0,1,2],[0,2,3]])triangle(c,img,ids.map(i=>src[i]),ids.map(i=>face.points[i]));c.restore();
  }
 }
 c.restore();
}
export function drawSpinWake(view,x,y,size,angle,speed=1){
 const c=view.ctx;c.save();c.translate(x,y);c.scale(1,.22);
 for(let n=0;n<3;n++){
  const a=angle+n*TAU/3;c.strokeStyle=`rgba(185,224,225,${Math.min(.4,.09+speed*.14)})`;c.lineWidth=1;
  c.beginPath();c.arc(0,0,size*(.31+n*.035),a,a+1.1);c.stroke();
 }
 c.restore();
}
