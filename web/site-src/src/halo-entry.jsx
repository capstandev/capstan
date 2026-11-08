import React from 'react'
import {createRoot} from 'react-dom/client'
import HaloCarousel from './components/HaloCarousel/HaloCarousel.jsx'
const container=document.querySelector('#halo-root')
if(container) createRoot(container).render(<HaloCarousel items={[
 {src:'assets/mascot-3d.png',alt:'Capstan mascot waving'},
 {src:'assets/banner.png',alt:'Capstan banner'},
 {src:'assets/mascot-original.png',alt:'Capstan mascot sticker'},
 {src:'assets/mascot-3d.png',alt:'Capstan mascot'},
 {src:'assets/banner.png',alt:'Capstan brand illustration'},
 {src:'assets/mascot-original.png',alt:'Capstan mascot sticker'}
]} eyebrow="A LITTLE COMPANION FOR A BIG WORLD" title="Good things come around." body="One API, a world of possibilities. Explore the many sides of Capstan." theme={{background:'#d8efff',card:'#b7e1fa',eyebrow:'#4a84a9',title:'#17385f',body:'#557d96',shadow:'rgba(39,92,125,.2)'}} wheel={false} />)
