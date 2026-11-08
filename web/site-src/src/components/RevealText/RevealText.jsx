import {motion, useReducedMotion} from 'framer-motion';
import React, {useEffect, useRef, useState} from 'react';
import './RevealText.css';

/* Adapted from the supplied RevealText: a staggered spring, colour sweep and
   per-letter image reveal, with local Capstan artwork and touch/keyboard support. */
const artwork = [
  'assets/banner.png',
  'assets/quote-fees-mascot.svg',
  'assets/capstan-search.webp',
  'assets/quote-slippage-mascot.svg',
  'assets/capstan-wave.webp',
  'assets/quote-risk-mascot.svg',
  'assets/quote-funding-mascot.svg',
];

export function RevealText({text='capstan',letterDelay=.08,overlayDelay=.05,overlayDuration=.4,springDuration=600}){
  const [hoveredIndex,setHoveredIndex]=useState(null);
  const [showOverlay,setShowOverlay]=useState(false);
  const reduce=useReducedMotion();
  const touchTimer=useRef(null);
  const letters=Array.from(text);

  useEffect(()=>{
    if(reduce){setShowOverlay(false);return undefined;}
    const timer=setTimeout(()=>setShowOverlay(true),Math.max(0,letters.length-1)*letterDelay*1000+springDuration);
    return()=>clearTimeout(timer);
  },[letters.length,letterDelay,springDuration,reduce]);
  useEffect(()=>()=>clearTimeout(touchTimer.current),[]);
  const key=(event)=>{
    if(event.key!=='ArrowRight'&&event.key!=='ArrowLeft')return;
    event.preventDefault();
    const direction=event.key==='ArrowRight'?1:-1;
    setHoveredIndex(index=>((index??0)+direction+letters.length)%letters.length);
  };
  return <span className="cap-footer-letters" role="group" aria-label="Capstan wordmark. Use arrow keys to explore its artwork." tabIndex={0}
    onFocus={()=>setHoveredIndex(0)} onBlur={()=>setHoveredIndex(null)} onKeyDown={key}>
    {letters.map((letter,index)=><motion.span key={index} className="cap-footer-letter" aria-hidden="true"
      initial={reduce?false:{scale:0,opacity:0}} animate={{scale:1,opacity:1}}
      transition={reduce?{duration:0}:{delay:index*letterDelay,type:'spring',damping:8,stiffness:200,mass:.8}}
      onPointerEnter={event=>{if(event.pointerType==='mouse')setHoveredIndex(index)}}
      onPointerLeave={event=>{if(event.pointerType==='mouse')setHoveredIndex(null)}}
      onPointerDown={event=>{if(event.pointerType!=='mouse'){setHoveredIndex(index);clearTimeout(touchTimer.current);touchTimer.current=setTimeout(()=>setHoveredIndex(null),1200)}}}>
      <motion.span className="cap-footer-letter-base" animate={{opacity:hoveredIndex===index?0:1}} transition={{duration:reduce?0:.1}}>{letter}</motion.span>
      <motion.span className="cap-footer-letter-art" style={{backgroundImage:`url('${artwork[index%artwork.length]}')`}}
        animate={{opacity:hoveredIndex===index?1:0,backgroundPosition:hoveredIndex===index?'10% center':'0% center'}}
        transition={reduce?{duration:0}:{opacity:{duration:.1},backgroundPosition:{duration:3,ease:'easeInOut'}}}>{letter}</motion.span>
      {showOverlay&&!reduce&&<motion.span className="cap-footer-letter-sweep" initial={{opacity:0}} animate={{opacity:[0,1,1,0]}}
        transition={{delay:index*overlayDelay,duration:overlayDuration,times:[0,.1,.7,1],ease:'easeInOut'}}>{letter}</motion.span>}
    </motion.span>)}
  </span>;
}
