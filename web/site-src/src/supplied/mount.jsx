import React from 'react';
import {createRoot} from 'react-dom/client';
export function mountSupplied(item){
 const main=document.querySelector('.bl-page');if(!main)return;
 const section=document.createElement('section');section.className='bl-section cap-supplied-section cap-supplied-'+item.page;
 section.innerHTML=`<div class="bl-wrap cap-supplied-grid"><div class="cap-supplied-copy"><span>${item.kicker}</span><h2>${item.heading}</h2><p>${item.copy}</p></div><div class="cap-supplied-mount"></div></div>`;
 const before=main.querySelector('.bl-end');main.insertBefore(section,before||null);
 const mount=section.querySelector('.cap-supplied-mount');const render=()=>createRoot(mount).render(item.node);
 if('IntersectionObserver' in window){const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){observer.disconnect();render()}},{rootMargin:'180px'});observer.observe(section)}else render();
}
