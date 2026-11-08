import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import FanCarousel from './components/FanCarousel/FanCarousel.jsx';
import ServiceCards from './components/ServiceCards/ServiceCards.jsx';
import './capstan-sections.css';

const steps = [
 {title:'Compare',subtitle:'Read the market',tag:'01',image:'assets/capstan-search.webp',heading:'Read the market',detail:'Compare markets and funding across the venues Capstan plans to support.',accent:'#4f96ca'},
 {title:'Preview',subtitle:'See the costs',tag:'02',image:'assets/capstan-wave.webp',heading:'See the costs',detail:'Review estimated venue fees, builder fees, slippage and funding before signing.',accent:'#64a99b'},
 {title:'Sign',subtitle:'Keep control',tag:'03',image:'assets/capstan-read.webp',heading:'Keep control',detail:'The intended SDK checks the order against your instructions and signs locally with a trade-only key.',accent:'#d49a61'},
 {title:'Understand',subtitle:'See risk by venue',tag:'04',image:'assets/mascot-3d-optimized.webp',heading:'See risk by venue',detail:'Positions and liquidation levels stay distinct. Each venue liquidates independently.',accent:'#9985bc'},
];
export function Flow(){
 const [selected,setSelected]=useState(0),s=steps[selected];
 return <div className="cap-flow-shell"><div className="cap-flow-top"><span>YOUR JOURNEY</span><span>Drag or select a card</span></div><FanCarousel className="cap-flow-fan" items={steps} startIndex={0} cardWidth={0.34} cardRatio={1.12} spread={0.18} rise={0.025} rotation={7} focusScale={1} neighbourScale={0.82} falloff={0.03} aspect={1.8} wheel={false} theme={{background:'linear-gradient(160deg,#e8f6ff,#d5ecf9)',scrim:'linear-gradient(180deg,rgba(17,54,87,.75),rgba(17,54,87,0) 48%)',title:'#fff',subtitle:'#fff',pill:'rgba(255,255,255,.85)',pillText:'#17385f',dot:'rgba(23,56,95,.28)',dotActive:'#17385f',shadow:'rgba(30,83,117,.28)'}} aria-label="Choose one of four Capstan workflow steps" onChange={(i)=>setSelected(i)}/><div className="cap-flow-detail" aria-live="polite"><span>STEP {selected+1} OF 4</span><div><h3>{s.heading}</h3><p>{s.detail}</p></div></div></div>
}
const quoteDetails=[
 {label:'01 · FEES',headline:'Venue and builder fees',statement:'Fees',image:'assets/quote-fees-mascot.svg',detail:'Compare the venue fee and, where applicable, the planned Capstan builder fee before signing.'},
 {label:'02 · EXECUTION',headline:'Cost from available depth',statement:'Slippage',image:'assets/quote-slippage-mascot.svg',detail:'Estimated slippage is based on the available order-book depth and the intended order size.'},
 {label:'03 · FUNDING',headline:'Cost over your holding time',statement:'Funding',image:'assets/quote-funding-mascot.svg',detail:'The planned quote estimates funding over the intended holding time and retains venue-specific settlement context.'},
 {label:'04 · RISK',headline:'Risk is specific to each venue',statement:'Risk',image:'assets/quote-risk-mascot.svg',detail:'Review a venue-specific liquidation estimate and remember: each venue liquidates independently.'},
];
const quoteAccents=['#93d4f2','#a6ddc9','#facb89','#c9b9ef'];
export function Quote(){
 const [selected,setSelected]=useState(0);
 const cards=quoteDetails.map((item,i)=>({image:item.image,alt:'',category:item.label,title:item.statement,description:item.headline,detail:'Planned quote component',cta:'Explore detail',accent:quoteAccents[i],href:'#cap-quote-detail',controls:'cap-quote-detail',current:selected===i ? 'true' : undefined,onClick:(event)=>{event.preventDefault();setSelected(i)}}));
 return <div className="cap-quote-shell"><ServiceCards className="cap-quote-cards" items={cards} minCardWidth={205} gap={14} imageRatio={0.9} radius={22} padding={18} lift={7} zoom={1.06} theme={{background:'transparent',card:'#fff',title:'#17385f',text:'#58778c',muted:'#7295a9',tag:'#eef7fb',badge:'#fff',ctaText:'#17385f'}}/><div id="cap-quote-detail" className="cap-quote-detail" aria-live="polite"><span>QUOTE DETAIL · PLANNED</span><div><h3>{quoteDetails[selected].headline}</h3><p>{quoteDetails[selected].detail}</p></div></div></div>
}
if(typeof document !== 'undefined'){
 const flow=document.getElementById('cap-flow-mount');if(flow)createRoot(flow).render(<Flow/>);
 const quote=document.getElementById('cap-quote-mount');if(quote)createRoot(quote).render(<Quote/>);
}
