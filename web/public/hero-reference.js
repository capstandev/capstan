/* Compact feature links complete the reference-inspired Capstan hero. */
(function(){
  const hero=document.querySelector('.bl-page > .bl-hero .bl-hero-grid');
  if(!hero||hero.querySelector('.cap-hero-cards'))return;
  hero.insertAdjacentHTML('beforeend',`<div class="cap-hero-cards" aria-label="Explore Capstan features">
    <a class="cap-hero-card cap-hero-card--markets" href="markets.html"><span class="cap-hero-icon" aria-hidden="true">⌁</span><span class="cap-hero-card-kicker">MARKETS</span><strong>One market view</strong><span class="cap-hero-card-note">All venues</span><span class="cap-hero-card-arrow" aria-hidden="true">↗</span></a>
    <a class="cap-hero-card cap-hero-card--quotes" href="quotes.html"><span class="cap-hero-icon" aria-hidden="true">✦</span><span class="cap-hero-card-kicker">QUOTES</span><strong>Clear before you sign</strong><span class="cap-hero-card-note">See the details</span><span class="cap-hero-card-arrow" aria-hidden="true">↗</span></a>
    <a class="cap-hero-card cap-hero-card--risk" href="risk.html"><span class="cap-hero-icon" aria-hidden="true">◈</span><span class="cap-hero-card-kicker">RISK</span><strong>Every venue, separate</strong><span class="cap-hero-card-note">Keep risk in view</span><span class="cap-hero-card-arrow" aria-hidden="true">↗</span></a>
  </div>`);
})();
