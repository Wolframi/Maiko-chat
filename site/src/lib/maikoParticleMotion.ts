const HASH_SIZE = 131072;
const hash = (x:number,y:number,z:number) => ((x*73856093)^(y*19349663)^(z*83492791))&(HASH_SIZE-1);
export const MAIKO_PARTICLE_LIMIT = 0.035;
export const MAIKO_PARTICLE_CORE_LIMIT = 0.003;
export const MAIKO_PARTICLE_ROAM_THRESHOLD = 0.9;
export const MAIKO_PARTICLE_AGITATION = 2.2;
export const MAIKO_PARTICLE_SPRING = 60;
export const MAIKO_PARTICLE_DRAG = 6;
export const MAIKO_PARTICLE_SPEED = 1.2;
export const MAIKO_PARTICLE_REPULSION = 120;
export const MAIKO_CURSOR_FALLOFF = 0.085;
export const MAIKO_CURSOR_STRENGTH = 0.055;
export const MAIKO_CURSOR_PULSE = 0.018;
export const MAIKO_CURSOR_SWIRL = 0.035;

/** Start the visible hover wave on entering the mascot, and fade it on exit. */
export class MaikoHover {
  readonly position={x:0,y:0};
  focus=0;
  age=0;
  private started=0;
  private active=false;
  step(width:number,height:number,scale:number,delta:number,time:number,pointer:{x:number;y:number}|null,motion:boolean) {
    const x=pointer?(pointer.x-width/2)/scale:0,y=pointer?(height/2-pointer.y)/scale:0;
    const active=!!pointer&&motion&&Math.abs(x)<1.3&&y>-1.3&&y<1.45;
    if(active&&!this.active)this.started=time;
    this.active=active;
    const smoothing=1-Math.exp(-Math.min(0.05,Math.max(0,delta))*8);
    this.focus+=((active?1:0)-this.focus)*smoothing;
    if(pointer){this.position.x+=(x-this.position.x)*smoothing;this.position.y+=(y-this.position.y)*smoothing;}
    this.age=Math.max(0,time-this.started);
  }
}

export function maikoHoverWave(distance:number,age:number,focus:number) {
  const radius=0.04+((age*0.75)%1)*0.43;
  return Math.exp(-(((distance-radius)/0.04)**2)-distance*distance/0.35)*focus;
}

/** Local surface springs: independent particles repel their three closest
 * neighbours. Offsets follow the skeleton, so a dancing arm keeps its detail.
 * The fixed neighbour graph avoids rebuilding an 84,000-point grid every frame.
 */
export class MaikoParticleMotion {
  readonly offsets:Float32Array;
  readonly velocity:Float32Array;
  readonly neighbours:Int32Array;
  readonly contact:number;
  private accumulator=0;

  constructor(private readonly data:Float32Array, readonly count:number, private readonly agitation=MAIKO_PARTICLE_AGITATION) {
    this.offsets=new Float32Array(count*3);
    this.velocity=new Float32Array(count*3);
    this.neighbours=new Int32Array(count*3).fill(-1);
    this.contact=Math.min(0.022,Math.max(0.007,0.007*Math.sqrt(84000/count)));
    const size=this.contact*2,heads=new Int32Array(HASH_SIZE).fill(-1),next=new Int32Array(count),cells=new Int32Array(count*3);
    for(let i=0;i<count;i++) {
      const k=i*3,d=i*16;
      const x=cells[k]=Math.floor(data[d]/size),y=cells[k+1]=Math.floor(data[d+1]/size),z=cells[k+2]=Math.floor(data[d+2]/size);
      const bucket=hash(x,y,z);next[i]=heads[bucket];heads[bucket]=i;
    }
    for(let i=0;i<count;i++) {
      const k=i*3,d=i*16,cx=cells[k],cy=cells[k+1],cz=cells[k+2];
      let first=size*size,second=first,third=first;
      for(let x=cx-1;x<=cx+1;x++) for(let y=cy-1;y<=cy+1;y++) for(let z=cz-1;z<=cz+1;z++) {
        for(let j=heads[hash(x,y,z)];j!==-1;j=next[j]) {
          const q=j*3,e=j*16;
          if(i===j||cells[q]!==x||cells[q+1]!==y||cells[q+2]!==z) continue;
          const dx=data[d]-data[e],dy=data[d+1]-data[e+1],dz=data[d+2]-data[e+2],distance=dx*dx+dy*dy+dz*dz;
          if(distance<first) {third=second;second=first;first=distance;this.neighbours[k+2]=this.neighbours[k+1];this.neighbours[k+1]=this.neighbours[k];this.neighbours[k]=j;}
          else if(distance<second) {third=second;second=distance;this.neighbours[k+2]=this.neighbours[k+1];this.neighbours[k+1]=j;}
          else if(distance<third) {third=distance;this.neighbours[k+2]=j;}
        }
      }
    }
  }

  advance(delta:number,time:number) {
    this.accumulator=Math.min(this.accumulator+Math.max(0,delta),1/15);
    let changed=false;
    while(this.accumulator>=1/60) {this.step(1/60,time);this.accumulator-=1/60;changed=true;}
    return changed;
  }

  step(delta:number,time:number) {
    const dt=Math.min(1/60,Math.max(0,delta)),p=this.offsets,v=this.velocity,d=this.data,drag=Math.exp(-MAIKO_PARTICLE_DRAG*dt);
    const movingTime=time*MAIKO_PARTICLE_SPEED;
    for(let i=0;i<this.count;i++) {
      const k=i*3,a=i*16,phase=d[a+15]*Math.PI*2;
      // Some brighter particles roam farther, while a dense moving core keeps
      // the eyes, clothing and silhouette readable.
      const activity=this.agitation*(d[a+15]>=MAIKO_PARTICLE_ROAM_THRESHOLD?1:0.1);
      let fx=-p[k]*MAIKO_PARTICLE_SPRING+Math.sin(movingTime*3.1+phase*13)*activity;
      let fy=-p[k+1]*MAIKO_PARTICLE_SPRING+Math.cos(movingTime*2.7+phase*19)*activity;
      let fz=-p[k+2]*MAIKO_PARTICLE_SPRING+Math.sin(movingTime*3.7+phase*23)*activity;
      for(let n=0;n<3;n++) {
        const j=this.neighbours[k+n];
        if(j<0) continue;
        const q=j*3,b=j*16;
        const dx=d[a]+p[k]-d[b]-p[q],dy=d[a+1]+p[k+1]-d[b+1]-p[q+1],dz=d[a+2]+p[k+2]-d[b+2]-p[q+2];
        const distance=Math.sqrt(dx*dx+dy*dy+dz*dz);
        if(distance>=this.contact) continue;
        if(distance<1e-7) {fx+=(i<j?-1:1)*this.contact*80;continue;}
        const force=(this.contact-distance)*MAIKO_PARTICLE_REPULSION/distance;
        fx+=dx*force;fy+=dy*force;fz+=dz*force;
      }
      v[k]=(v[k]+fx*dt)*drag;v[k+1]=(v[k+1]+fy*dt)*drag;v[k+2]=(v[k+2]+fz*dt)*drag;
    }
    for(let i=0;i<this.count;i++) {
      const k=i*3;
      for(let axis=0;axis<3;axis++) p[k+axis]+=v[k+axis]*dt;
      const length=Math.sqrt(p[k]*p[k]+p[k+1]*p[k+1]+p[k+2]*p[k+2]);
      const limit=d[i*16+15]>=MAIKO_PARTICLE_ROAM_THRESHOLD?MAIKO_PARTICLE_LIMIT:MAIKO_PARTICLE_CORE_LIMIT;
      if(length>limit) {
        const ratio=limit/length;
        for(let axis=0;axis<3;axis++) {p[k+axis]*=ratio;v[k+axis]*=0.55;}
      }
    }
  }
}

/** Bounded cursor repulsion, mirrored in the GPU shader. The falloff spreads
 * particles gently rather than emptying a disc in the face. */
export function maikoCursorRepulsion(x:number,y:number,seed:number,time:number,focus:number,hoverAge=0) {
  const distance=Math.hypot(x,y),falloff=Math.exp(-distance*distance/MAIKO_CURSOR_FALLOFF);
  const phase=seed*Math.PI*2;
  const directionX=distance>0.001?x/distance:Math.cos(phase),directionY=distance>0.001?y/distance:Math.sin(phase);
  const mobility=seed>=MAIKO_PARTICLE_ROAM_THRESHOLD?1:0.025;
  const strength=falloff*focus*(MAIKO_CURSOR_STRENGTH+MAIKO_CURSOR_PULSE*Math.sin(time*5+phase))*mobility;
  const swirl=falloff*focus*mobility*MAIKO_CURSOR_SWIRL*Math.sin(hoverAge*4+phase);
  return [directionX*strength-directionY*swirl,directionY*strength+directionX*swirl] as const;
}
