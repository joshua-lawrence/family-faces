// Phones: keep the current tab in view after tabs and fonts are ready.
(() => {
  const nav = document.querySelector('nav#tabs');
  if (!nav) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const show = () => {
    const on = nav.querySelector('button.on');
    if (!on || !nav.clientWidth || nav.scrollWidth <= nav.clientWidth + 1) return;
    const n = nav.getBoundingClientRect(), b = on.getBoundingClientRect();
    if (b.left >= n.left && b.right <= n.right) return;
    nav.scrollBy({ left: b.left - n.left - (n.width - b.width) / 2, behavior: reduce.matches ? 'auto' : 'smooth' });
  };
  new MutationObserver(() => requestAnimationFrame(show)).observe(nav,
    { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  nav.addEventListener('scrollend', show);
  addEventListener('load', show);
  addEventListener('resize', show);
  document.fonts?.ready.then(() => requestAnimationFrame(show));
  requestAnimationFrame(show);
})();
