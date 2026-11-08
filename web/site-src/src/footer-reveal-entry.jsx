import React from 'react';
import {createRoot} from 'react-dom/client';
import {RevealText} from './components/RevealText/RevealText.jsx';

class FooterRevealBoundary extends React.Component {
  constructor(props){super(props);this.state={failed:false}}
  static getDerivedStateFromError(){return {failed:true}}
  render(){return this.state.failed ? 'capstan' : this.props.children}
}
window.mountCapstanFooterReveal=(element)=>{
  if(!element)return;
  const root=createRoot(element);
  root.render(<FooterRevealBoundary><RevealText/></FooterRevealBoundary>);
};
