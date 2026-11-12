import React from 'react';
import {createRoot} from 'react-dom/client';
import MediaFolder from './components/MediaFolder/MediaFolder.jsx';

const items = [
  {src:'assets/capstan-search.webp',title:'Markets & data',x:-0.28,y:-0.14,width:0.19,rotate:-3},
  {src:'assets/capstan-wave.webp',title:'Quotes & orders',x:0,y:-0.22,width:0.19,rotate:2},
  {src:'assets/capstan-read.webp',title:'Risk & receipts',x:0.28,y:-0.13,width:0.19,rotate:3},
  {src:'assets/mascot-3d-optimized.webp',title:'Local signing',x:-0.18,y:0.16,width:0.18,rotate:2},
];
const fallback = [
  ['markets.html','Markets & data','Explore markets, books and funding.'],
  ['quotes.html','Quotes & orders','Review estimated costs before signing.'],
  ['risk.html','Risk & receipts','Understand risk by venue.'],
  ['developers.html','Build with Capstan','Explore the API, SDK and MCP.'],
];
class FolderBoundary extends React.Component {
  constructor(props){super(props);this.state={failed:false}}
  static getDerivedStateFromError(){return {failed:true}}
  render(){return this.state.failed ? <div className="cap-folder-fallback" aria-label="Capstan toolkit">{fallback.map(([href,title,desc],i)=><a href={href} key={href}><span>{String(i+1).padStart(2,'0')}</span><strong>{title}</strong><small>{desc}</small><b aria-hidden="true">↗</b></a>)}</div> : this.props.children}
}
const el = document.querySelector('#cap-folder-mount');
if(el) createRoot(el).render(<FolderBoundary><MediaFolder items={items} label="Capstan toolkit" folderSize={0.18} windowWidth={0.18} aspect={1.75} theme={{background:'#e4f4fd',label:'#17385f',folder:'#3196df',folderLight:'#a5dcfb',folderBack:'#318bd1',folderShade:'#1d5685',window:'rgba(255,255,255,.84)',windowText:'#17385f',accent:'#318dd4'}} /></FolderBoundary>);
