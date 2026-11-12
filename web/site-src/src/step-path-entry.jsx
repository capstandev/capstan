import React from 'react';
import {createRoot} from 'react-dom/client';
import StepPath from './components/StepPath/StepPath.jsx';
const steps=[
 {title:'Choose',text:'Select a market and understand the venue-specific quote before proceeding.'},
 {title:'Check',text:'Review fees, estimated slippage and funding for the intended holding time.'},
 {title:'Sign locally',text:'The SDK verifies the order and signs with a delegated trade-only key.'},
 {title:'Keep context',text:'Positions, collateral and liquidation remain separate for every venue.'},
];
const el=document.querySelector('#cap-step-path');
if(el)createRoot(el).render(<StepPath steps={steps} theme={{background:'#f4faff',title:'#17385f',number:'#368ece',text:'#5e7a8d',line:'#358ecd',dot:'#318edb'}}/>);
