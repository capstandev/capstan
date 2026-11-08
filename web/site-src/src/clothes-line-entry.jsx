import React, {useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import ClothesLine from './components/ClothesLine/ClothesLine.jsx';
import './capstan-clothes-line.css';

const items = [
  {src:'assets/quote-slippage-mascot.svg',title:'Markets',caption:'Data & books'},
  {src:'assets/quote-fees-mascot.svg',title:'Quotes',caption:'Costs in view'},
  {src:'assets/quote-risk-mascot.svg',title:'Risk',caption:'By venue'},
  {src:'assets/capstan-read.webp',title:'Build',caption:'API · SDK · MCP'},
];
const links = [
  ['markets.html','Markets & data','Markets, books and funding'],
  ['quotes.html','Quotes & orders','Review estimated costs'],
  ['risk.html','Risk & receipts','Understand venue-specific risk'],
  ['developers.html','Build with Capstan','Explore the API, SDK and MCP'],
];
export function ToolkitLinks(){return <div className="cap-rope-links" aria-label="Explore the toolkit">{links.map(([href,title,copy],i)=><a href={href} key={href}><span className="cap-rope-number">0{i+1}</span><span><strong>{title}</strong><small>{copy}</small></span><b aria-hidden="true">↗</b></a>)}</div>}
export function Toolkit(){
 const ref=useRef(null);const [small,setSmall]=useState(false);
 useEffect(()=>{const el=ref.current;if(!el)return;const update=()=>setSmall(el.clientWidth<660);update();const ro=typeof ResizeObserver==='function'?new ResizeObserver(update):null;if(ro)ro.observe(el);else window.addEventListener('resize',update);return()=>{ro?.disconnect();if(!ro)window.removeEventListener('resize',update)}},[]);
 return <div className="cap-rope-toolkit" ref={ref}><div className="cap-rope-top"><span>THE CAPSTAN TOOLKIT</span><span>Drag the line to explore <b aria-hidden="true">↔</b></span></div><ClothesLine key={small?'phone':'wide'} aria-hidden="true" items={items} label="Capstan toolkit illustrations" wheel={false} speed={.018} aspect={small?1.2:2.5} ropeY={small?.25:.27} sag={.055} cardWidth={small?.38:.19} cardRatio={small?1:1.05} spacing={small?.42:.235} radius={18} drop={.012} naturalTilt={2} theme={{background:'#e3f5ff',rope:'#d89d60',ropeLight:'#ffdc9e',card:'#cbeaff',peg:'#e5ac6e',wire:'#17385f',shadow:'rgba(31,92,129,.20)'}}/><ToolkitLinks/></div>
}
class ToolkitBoundary extends React.Component {constructor(props){super(props);this.state={failed:false}}static getDerivedStateFromError(){return {failed:true}}render(){return this.state.failed?<ToolkitLinks/>:this.props.children}}
if(typeof document!=='undefined'){const mount=document.getElementById('cap-folder-mount');if(mount)createRoot(mount).render(<ToolkitBoundary><Toolkit/></ToolkitBoundary>);}
