import React,{useLayoutEffect,useRef,useState} from 'react';
import TearTicket from '../components/TearTicket/TearTicket';
export default function SizedTicket(){
  const ref=useRef(null); const [scale,setScale]=useState(1);
  useLayoutEffect(()=>{const el=ref.current;if(!el)return;const size=()=>setScale(Math.min(1,el.clientWidth/600));size();const ro=typeof ResizeObserver==='function'?new ResizeObserver(size):null;if(ro)ro.observe(el);else window.addEventListener('resize',size);return()=>{if(ro)ro.disconnect();else window.removeEventListener('resize',size)}},[]);
  const ticket={operator:'CAPSTAN · WORKFLOW',serial:'SPECIFICATION · 001',from:'Market',to:'Clarity',depart:'Compare venues',arrive:'Review details',fields:[['View','Markets'],['Check','Quotes'],['Risk','By venue'],['Stage','Planned']],stubBanner:'Explore',stubLabel:'Step',stubValue:'01',stubNote:'A clearer view'};
  return <><div className="cap-ticket-viewport" ref={ref} style={{height:480*scale}}><div className="cap-ticket-scaled" style={{transform:`scale(${scale})`}}><TearTicket ticket={ticket} theme={{background:'#d6eefc',paper:'#f7fcff',back:'#dfedf6',ink:'#17385f',muted:'#65869a',accent:'#368fd1',guilloche:'rgba(54,143,209,.16)',shadow:'#396987'}}/></div></div><div className="cap-ticket-mobile-summary" aria-hidden="true"><strong>Market → Clarity</strong><span>Markets · Quotes · Risk by venue</span><small>Planned workflow</small></div></>
}

