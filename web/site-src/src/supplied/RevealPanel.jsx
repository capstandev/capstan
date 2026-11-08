import React,{useEffect,useRef} from 'react';
/* Adapted from the supplied Imagine reveal: video stays a DOM element, while
   a 2D mask opens and gradually closes at the pointer.  No video pixels are read. */
export default function RevealPanel(){
 const host=useRef(null), cv=useRef(null),vid=useRef(null);
 useEffect(()=>{
  const el=host.current,canvas=cv.current,video=vid.current,ctx=canvas?.getContext('2d');if(!el||!ctx||!video)return;
  const trail=document.createElement('canvas'),t=trail.getContext('2d');if(!t)return;
  const reduce=window.matchMedia('(prefers-reduced-motion: reduce)');let w=0,h=0,dpr=1,raf=0,visible=false,last=0,lastMark=0,prev=null,drops=[];
  const clear=()=>{t.clearRect(0,0,w,h);draw()};
  const draw=()=>{ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);ctx.fillStyle='#d9f1ff';ctx.fillRect(0,0,w,h);ctx.font=`900 ${Math.min(w*.15,120)}px Nunito, sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle='#17385f';ctx.fillText('CAPSTAN',w/2,h/2);ctx.globalCompositeOperation='destination-out';ctx.drawImage(trail,0,0,w,h);ctx.globalCompositeOperation='source-over'};
  const resize=()=>{w=el.clientWidth;h=el.clientHeight;dpr=Math.min(window.devicePixelRatio||1,2);canvas.width=Math.ceil(w*dpr);canvas.height=Math.ceil(h*dpr);trail.width=w;trail.height=h;draw()};
  const stamp=(x,y,r,a)=>{const g=t.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,`rgba(0,0,0,${a})`);g.addColorStop(.65,`rgba(0,0,0,${a*.9})`);g.addColorStop(1,'rgba(0,0,0,0)');t.fillStyle=g;t.beginPath();t.arc(x,y,r,0,Math.PI*2);t.fill()};
  const tick=(now)=>{raf=0;if(!visible)return;const dt=Math.min((now-last)/16.67||1,3);last=now;t.globalCompositeOperation='destination-out';t.fillStyle=`rgba(0,0,0,${1-Math.pow(.95,dt)})`;t.fillRect(0,0,w,h);t.globalCompositeOperation='source-over';drops=drops.filter(p=>{p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=.24*dt;p.life-=.035*dt;if(p.life<=0)return false;stamp(p.x,p.y,p.r*p.life,p.life*.8);return true});draw();if(now-lastMark<2600||drops.length)raf=requestAnimationFrame(tick);else clear()};
  const mark=e=>{if(reduce.matches)return;const r=el.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top,rad=Math.max(36,Math.min(w,h)*.12);if(prev){const dx=x-prev[0],dy=y-prev[1],dist=Math.hypot(dx,dy),n=Math.max(1,Math.ceil(dist/(rad*.3)));for(let i=0;i<=n;i++)stamp(prev[0]+dx*i/n,prev[1]+dy*i/n,rad,.85);if(dist>15&&drops.length<30)drops.push({x,y,vx:dx*.08,vy:dy*.08,r:rad*.32,life:1})}else stamp(x,y,rad,.9);prev=[x,y];lastMark=performance.now();if(visible&&!raf){last=lastMark;raf=requestAnimationFrame(tick)}};
  const leave=()=>{prev=null};el.addEventListener('pointerdown',mark);el.addEventListener('pointermove',mark);el.addEventListener('pointerleave',leave);el.addEventListener('pointercancel',leave);el.addEventListener('pointerup',leave);
  const ro=typeof ResizeObserver==='function'?new ResizeObserver(resize):null;if(ro)ro.observe(el);else window.addEventListener('resize',resize);resize();el.classList.add('has-reveal');
  let inView=false;const syncVisibility=()=>{visible=inView&&!document.hidden&&!reduce.matches;if(visible)video.play().catch(()=>{});else{video.pause();if(raf){cancelAnimationFrame(raf);raf=0}}};
  const io=typeof IntersectionObserver==='function'?new IntersectionObserver(([entry])=>{inView=entry.isIntersecting;syncVisibility()},{threshold:.05}):null;if(io)io.observe(el);else{inView=true;syncVisibility()}document.addEventListener('visibilitychange',syncVisibility);reduce.addEventListener?.('change',syncVisibility);
  return()=>{if(raf)cancelAnimationFrame(raf);video.pause();io?.disconnect();if(ro)ro.disconnect();else window.removeEventListener('resize',resize);document.removeEventListener('visibilitychange',syncVisibility);reduce.removeEventListener?.('change',syncVisibility);el.removeEventListener('pointerdown',mark);el.removeEventListener('pointermove',mark);el.removeEventListener('pointerleave',leave);el.removeEventListener('pointercancel',leave);el.removeEventListener('pointerup',leave)};
 },[]);
 return <div className="cap-reveal-panel" ref={host} aria-label="Interactive illustration: move over the panel to reveal the Capstan mascot"><video ref={vid} src="assets/mascot-landing-wave.mp4" muted loop playsInline preload="metadata" aria-hidden="true"/><div className="cap-reveal-fallback" aria-hidden="true">CAPSTAN</div><canvas ref={cv} aria-hidden="true"/><span className="cap-reveal-hint" aria-hidden="true">Move or touch to reveal ✦</span></div>
}
