/* Page loaders: the Capstan jump video, or the seven-bar liquid wave. */
(function(){
  const app=document.getElementById('app');
  if(!app)return;
  const route=(location.pathname.split('/').pop()||'index.html').replace(/\.html$/,'');
  const mascotLoader=route==='index'||route==='dashboard';
  const reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const overlay=document.createElement('div');
  overlay.id='cap-preloader';
  overlay.className='cap-preloader '+(mascotLoader?'cap-preloader-mascot':'cap-preloader-liquid');
  overlay.setAttribute('role','status');
  overlay.setAttribute('aria-live','polite');
  overlay.setAttribute('aria-label','Loading Capstan');
  // The original flat sticker mascot, with its raised hand animated separately.
  const wavingMascot=`<svg class="cap-waving-mascot" viewBox="0 0 200 200" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="wave-body" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#fbfeff"/><stop offset=".55" stop-color="#e6f5ff"/><stop offset="1" stop-color="#b9dfff"/></linearGradient>
      <linearGradient id="wave-limb" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#fff"/><stop offset="1" stop-color="#c4e7ff"/></linearGradient>
      <pattern id="wave-rope" width="7" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(-22)"><rect width="7" height="14" fill="#efbc7b"/><path d="M1 0v14" stroke="#c98a4c" stroke-width="1.6"/></pattern>
    </defs>
    <g class="cap-wave-sticker" fill="#fff" stroke="#fff" stroke-width="13" stroke-linecap="round" stroke-linejoin="round">
      <path d="M41 72 Q40 91 47 116 Q51 128 45 140 Q37 155 48 162 Q62 173 100 173 Q139 173 154 163 Q165 158 161 148 Q159 141 154 135 Q149 126 151 110 Q154 90 154 74 Q157 65 150 60 Q142 55 130 55 H57 Q44 56 41 72Z"/>
      <path d="M44 63 L97 48 L155 51 M96 48 L96 29" fill="none" stroke-width="20"/>
      <circle cx="95" cy="29" r="11"/><circle cx="43" cy="64" r="11"/><circle cx="151" cy="53" r="11"/>
      <ellipse cx="75" cy="168" rx="15" ry="8"/><ellipse cx="126" cy="166" rx="14" ry="8"/><ellipse cx="43" cy="123" rx="10" ry="11"/>
    </g>
    <g class="cap-wave-character">
      <g fill="url(#wave-limb)" stroke="#17385f" stroke-width="3.5"><path d="M61 163 Q60 174 73 176 Q87 178 92 166Z"/><path d="M111 165 Q113 174 126 174 Q139 173 139 162Z"/></g>
      <path d="M43 74 C43 93 48 108 50 123 Q52 132 47 142 C42 151 42 158 49 162 C61 171 82 172 100 172 C123 172 144 169 154 162 C161 157 159 151 155 145 C149 136 147 130 149 119 C151 102 154 89 153 74Z" fill="url(#wave-body)" stroke="#17385f" stroke-width="3.5" stroke-linejoin="round"/>
      <path d="M51 129 Q94 131 150 122 L154 138 Q99 149 47 143Z" fill="url(#wave-rope)" stroke="#17385f" stroke-width="2.6" stroke-linejoin="round"/>
      <ellipse cx="98" cy="75" rx="55" ry="11" fill="#d6efff" stroke="#17385f" stroke-width="3.5"/>
      <path d="M55 77 Q97 87 140 74" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="2.1" stroke-linecap="round"/>
      <path d="M84 56 L85 72 Q86 76 96 76 Q106 76 106 71 L105 55Z" fill="#70baf1" stroke="#17385f" stroke-width="3.5" stroke-linejoin="round"/>
      <ellipse cx="79" cy="97" rx="6" ry="8.5" fill="#17385f"/><circle cx="77" cy="94" r="2.3" fill="#fff"/><circle cx="81.5" cy="100" r="1.1" fill="#fff"/>
      <ellipse cx="116" cy="97" rx="6" ry="8.5" fill="#17385f"/><circle cx="114" cy="94" r="2.3" fill="#fff"/><circle cx="118.5" cy="100" r="1.1" fill="#fff"/>
      <ellipse cx="66" cy="108" rx="7.4" ry="4.3" fill="#ffb4c7"/><ellipse cx="129" cy="105" rx="7.4" ry="4.3" fill="#f3aec4"/>
      <path d="M91 103 L104 102 Q103 110 97.5 110 Q93 110 91 103Z" fill="#17385f"/><ellipse cx="98" cy="108.6" rx="3" ry="1.7" fill="#ff91ac"/>
      <ellipse cx="44" cy="124" rx="8.5" ry="10" transform="rotate(28 44 124)" fill="url(#wave-limb)" stroke="#17385f" stroke-width="3.5"/>
      <path d="M43 64 L95 48" fill="none" stroke="#17385f" stroke-width="13" stroke-linecap="round"/><path d="M43 64 L95 48" fill="none" stroke="#efbc7b" stroke-width="7" stroke-linecap="round"/><path d="M56 59 L82 51" fill="none" stroke="#fff1da" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M96 48 L150 51" fill="none" stroke="#17385f" stroke-width="13" stroke-linecap="round"/><path d="M96 48 L150 51" fill="none" stroke="#efbc7b" stroke-width="7" stroke-linecap="round"/><path d="M108 49 L139 51" fill="none" stroke="#fff1da" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M95 45 L93 31" fill="none" stroke="#17385f" stroke-width="8" stroke-linecap="round"/><path d="M95 45 L93 31" fill="none" stroke="#efbc7b" stroke-width="4" stroke-linecap="round"/>
      <g fill="#cc8d4a" stroke="#17385f" stroke-width="3.5"><circle cx="43" cy="64" r="8.7"/><circle cx="150" cy="52" r="8.7"/><circle cx="94" cy="29" r="8.5"/></g>
      <g fill="#f8dfbb" opacity=".95"><circle cx="40.5" cy="61.5" r="2"/><circle cx="147.5" cy="49.5" r="2"/><circle cx="91.5" cy="26.5" r="2"/></g>
      <g class="cap-wave-hand"><ellipse cx="160" cy="99" rx="14" ry="14.5" fill="#fff"/><ellipse cx="160" cy="99" rx="10.3" ry="10.5" fill="url(#wave-limb)" stroke="#17385f" stroke-width="3.5"/></g>
    </g>
  </svg>`;
  if(mascotLoader){
    overlay.innerHTML='<div class="cap-preloader-gradient"></div><div class="cap-preloader-center"><div class="cap-waving-stage">'+wavingMascot+(reduce?'':'<video class="cap-preloader-video" src="assets/mascot-preloader-jump.mp4" muted autoplay playsinline loop preload="auto" aria-hidden="true"></video>')+'</div><p>Getting things ready<span class="cap-loading-ellipsis" aria-hidden="true">...</span></p></div>';
    const stage=overlay.querySelector('.cap-waving-stage');
    const video=stage&&stage.querySelector('.cap-preloader-video');
    if(video){video.addEventListener('playing',()=>stage.classList.add('has-jump-video'));video.addEventListener('error',()=>stage.classList.remove('has-jump-video'));}
  }else{
    overlay.innerHTML='<div class="cap-liquid-content"><div class="cap-liquid-bars" aria-hidden="true">'+Array.from({length:7},(_,i)=>'<div class="cap-liquid-column" style="--liquid-index:'+i+'"><span class="cap-liquid-drop"></span><span class="cap-liquid-bar"><i></i></span><span class="cap-liquid-base"></span></div>').join('')+'</div><p>Getting things ready<span class="cap-loading-ellipsis" aria-hidden="true">...</span></p></div>';
  }
  document.documentElement.classList.add('cap-preloading');
  app.setAttribute('inert','');
  app.setAttribute('aria-busy','true');
  app.before(overlay);
  let finished=false,loadReady=document.readyState==='complete';
  const start=Date.now(),minimum=reduce?80:2000;
  let safetyTimer;
  function remove(){
    if(!overlay.isConnected)return;
    overlay.remove();
    app.removeAttribute('inert');
    app.removeAttribute('aria-busy');
    document.documentElement.classList.remove('cap-preloading');
  }
  function finish(force){
    if(finished||(!loadReady&&!force))return;
    const remaining=Math.max(0,minimum-(Date.now()-start));
    if(remaining){setTimeout(()=>finish(force),remaining);return}
    finished=true;clearTimeout(safetyTimer);
    app.removeAttribute('inert');app.removeAttribute('aria-busy');
    document.documentElement.classList.remove('cap-preloading');
    overlay.classList.add('cap-preloader-exit');
    overlay.addEventListener('transitionend',remove,{once:true});
    setTimeout(remove,reduce?100:500);
  }
  if(loadReady)finish(false);
  else window.addEventListener('load',()=>{loadReady=true;finish(false)},{once:true});
  safetyTimer=setTimeout(()=>finish(true),4000);
})();
