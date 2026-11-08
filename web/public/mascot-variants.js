/* Role-specific Capstan characters and opt-in story interactions. */
(function(){
  'use strict';
  if(typeof window.blRig!=='function')return;
  const ink='#17385f', light='#e4f5ff', blue='#73bcec', gold='#e9ad67';
  const arm=(x,y)=>`<path d="M70 59 Q73 58 ${x} ${y}" fill="none" stroke="${ink}" stroke-width="6.6" stroke-linecap="round"/><path d="M70 59 Q73 58 ${x} ${y}" fill="none" stroke="${light}" stroke-width="3.4" stroke-linecap="round"/><ellipse cx="${x}" cy="${y}" rx="3.5" ry="3.2" fill="${light}" stroke="${ink}" stroke-width="1.5"/>`;
  const props={
    loupe:`<path d="M75 53 79 48" stroke="${ink}" stroke-width="3.5" stroke-linecap="round"/><circle cx="83" cy="43.5" r="7" fill="#d8f2ff" stroke="${ink}" stroke-width="2.2"/><path d="M80 41 Q82 39 84 40" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round"/>${arm(75,53)}`,
    code:`<rect x="69" y="39" width="23" height="17" rx="3.2" fill="white" stroke="${ink}" stroke-width="1.8"/><path d="M70 43.5h21" stroke="#9ccce9" stroke-width="1"/><path d="m77 47-3 2.5 3 2.5m7-5 3 2.5-3 2.5" fill="none" stroke="${blue}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>${arm(72,54)}`,
    chart:`<rect x="70" y="37" width="20" height="23" rx="2.5" fill="#fff" stroke="${ink}" stroke-width="1.8"/><path d="M74 41h12M74 55h12" stroke="#cce5f4" stroke-width="1.2"/><path d="m74 52 3-3 2 2 3-5 4 2" fill="none" stroke="#4b9fd6" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>${arm(72,55)}`,
    compass:`<circle cx="82" cy="46" r="8.5" fill="white" stroke="${ink}" stroke-width="1.8"/><path d="m84.5 42-2 6-5 2 2-6z" fill="${gold}" stroke="${ink}" stroke-width="1"/>${arm(76,54)}`
  };
  function makeRig(type,prop){
    const template=document.createElement('template');template.innerHTML=window.blRig(type).trim();
    const svg=template.content.firstElementChild;
    if(svg)decorate(svg,prop);
    return svg;
  }
  function decorate(svg,kind){
    const holder=svg.querySelector('.cap-prop');
    if(!holder||!props[kind])return;
    holder.innerHTML=props[kind];svg.classList.add('cap-has-grip','cap-variant-'+kind);
  }
  // Keep the magnifying glass attached to a visible gripping hand. The toolkit
  // and page-header versions instead carry a market chart, so the two scenes differ.
  document.querySelectorAll('.bl-card-mascot .cap-rig--markets, .bl-detail-hero .cap-rig--markets').forEach(svg=>decorate(svg,'loupe'));
  document.querySelectorAll('.bl-tool-image .cap-rig--markets, .cap-page-scene[data-scene="markets"] .cap-rig--markets').forEach(svg=>decorate(svg,'chart'));

  const audience=document.querySelector('.bl-audience-grid');
  if(audience){
    const cards=audience.querySelectorAll('article');
    [[0,'code','code','developer'],[3,'wallet','chart','trader']].forEach(([index,type,prop,role])=>{
      const art=cards[index]?.querySelector(':scope > div');if(!art)return;
      const svg=makeRig(type,prop);if(!svg)return;
      art.replaceChildren(svg);art.classList.add('cap-audience-'+role);
      if('IntersectionObserver' in window){art.classList.add('cap-await-visibility');const observer=new IntersectionObserver(entries=>entries.forEach(entry=>entry.target.classList.toggle('is-visible',entry.isIntersecting)),{rootMargin:'100px'});observer.observe(art)}
    });
  }

  const story=document.querySelector('.bl-story');
  if(story){
    const stages=story.querySelectorAll('.bl-story-art');
    const choices=[
      {type:'compass',prop:'compass',name:'Gather market information',initial:'Tap to gather the details',active:'Details brought together',items:['Markets','Funding','Quotes'],className:'cap-story-gather'},
      {type:'markets',prop:'loupe',name:'Compare venue information',initial:'Tap to compare venues',active:'Venue details side by side',items:['Venue A','Venue B'],className:'cap-story-compare'}
    ];
    choices.forEach((choice,index)=>{
      const stage=stages[index];if(!stage)return;
      const rig=makeRig(choice.type,choice.prop);if(!rig)return;
      const button=document.createElement('button');button.type='button';button.className='cap-story-action '+choice.className;button.setAttribute('aria-label',choice.name);button.setAttribute('aria-pressed','false');
      const figure=document.createElement('span');figure.className='cap-story-figure';figure.setAttribute('aria-hidden','true');figure.appendChild(rig);
      const chips=document.createElement('span');chips.className='cap-story-chips';chips.setAttribute('aria-hidden','true');choice.items.forEach(item=>{const chip=document.createElement('span');chip.textContent=item;chips.appendChild(chip)});
      const hint=document.createElement('span');hint.className='cap-story-hint';hint.textContent=choice.initial;
      button.append(figure,chips,hint);stage.replaceChildren(button);
      button.addEventListener('click',()=>{const active=button.getAttribute('aria-pressed')!=='true';button.setAttribute('aria-pressed',String(active));button.classList.toggle('is-active',active);hint.textContent=active?choice.active:choice.initial;});
    });
  }
})();
