import React from 'react';
import {createRoot} from 'react-dom/client';
import EyeButton from './components/EyeButton/EyeButton.jsx';
window.mountCapstanEye=(node)=>{const root=createRoot(node);root.render(<EyeButton href="dashboard.html" fontSize={14} eyeSize={20} paddingX={18} paddingY={9} eyeGap={3} theme={{button:'#17385f',text:'#ffffff',eye:'#ffffff',pupil:'#17385f',shadow:'rgba(23,56,95,.15)'}}>Open dashboard</EyeButton>);return()=>root.unmount()};
