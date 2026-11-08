/* Each page mounts just its own local clip. The layered character remains as a fallback. */
(function(){
  const page=(location.pathname.split('/').pop()||'index.html').replace(/\.html$/,'');
  const clips={
    index:{file:'assets/mascot-landing-wave.mp4',host:'.bl-hero-art',kind:'landing'},
    dashboard:{file:'assets/mascot-dashboard-open.mp4',host:'.dash-mascot-action',kind:'dashboard'},
    'use-cases':{file:'assets/mascot-use-cases.mp4',host:'.cap-page-scene',kind:'interior'},
    pricing:{file:'assets/mascot-pricing.mp4',host:'.cap-page-scene',kind:'interior'},
    about:{file:'assets/mascot-about.mp4',host:'.cap-page-scene',kind:'interior'},
    developers:{file:'assets/mascot-landing-open.mp4',host:'.bl-end-art',kind:'cta'},
    'case-developers':{file:'assets/mascot-landing.mp4',host:'.bl-end-art',kind:'cta'},
    'case-agents':{file:'assets/mascot-dashboard.mp4',host:'.bl-end-art',kind:'cta'}
  };
  const choice=clips[page];if(!choice)return;
  let dispose=()=>{};
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  window.refreshCapstanMascotVideo=function(){
    dispose();
    const host=document.querySelector(choice.host);if(!host)return;
    host.classList.add('cap-scene-video-'+page);
    const layer=document.createElement('span');layer.className='cap-video-layer cap-video-'+choice.kind;layer.setAttribute('aria-hidden','true');
    const video=document.createElement('video');video.className='cap-mascot-video';video.src=choice.file;video.muted=true;video.defaultMuted=true;video.loop=true;video.playsInline=true;video.preload=choice.kind==='cta'?'none':'metadata';video.setAttribute('muted','');video.setAttribute('playsinline','');video.setAttribute('aria-hidden','true');layer.appendChild(video);host.appendChild(layer);
    let visible=!('IntersectionObserver' in window),dead=false;
    const shouldReduce=()=>reduced.matches||document.body.classList.contains('reduced');
    const fallback=choice.kind==='landing'?host.querySelector('.bl-hero-character'):null;
    function showFallback(){host.classList.remove('cap-video-ready');if(fallback){fallback.removeAttribute('tabindex');fallback.removeAttribute('aria-hidden')}host.closest('.bl-hero')?.classList.remove('cap-has-video')}
    function update(){if(dead)return;if(visible&&!document.hidden&&!shouldReduce()){try{const promise=video.play();if(promise&&promise.catch)promise.catch(showFallback)}catch(e){showFallback()}}else{video.pause();if(shouldReduce())showFallback()}}
    function ready(){if(!dead&&!shouldReduce()){host.classList.add('cap-video-ready');if(fallback){fallback.tabIndex=-1;fallback.setAttribute('aria-hidden','true')}host.closest('.bl-hero')?.classList.add('cap-has-video')}}
    function failed(){showFallback()}
    video.addEventListener('playing',ready);video.addEventListener('error',failed);
    let observer;if('IntersectionObserver' in window){observer=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;update()},{threshold:.05});observer.observe(host)}
    document.addEventListener('visibilitychange',update);document.addEventListener('change',update);reduced.addEventListener?.('change',update);update();
    dispose=()=>{dead=true;observer?.disconnect();video.pause();video.removeEventListener('playing',ready);video.removeEventListener('error',failed);document.removeEventListener('visibilitychange',update);document.removeEventListener('change',update);reduced.removeEventListener?.('change',update);showFallback();layer.remove()};
  };
  window.refreshCapstanMascotVideo();
})();
