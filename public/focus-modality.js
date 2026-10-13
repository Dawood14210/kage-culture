// Keep focus outlines keyboard-only, including inputs whose native
// :focus-visible heuristic also matches a pointer click. Tab restores rings.
(() => {
  const root = document.documentElement;
  root.dataset.focusModality = 'keyboard';
  document.addEventListener('pointerdown', () => { root.dataset.focusModality = 'pointer'; }, true);
  document.addEventListener('keydown', event => {
    if (!event.metaKey && !event.ctrlKey && !event.altKey) root.dataset.focusModality = 'keyboard';
  }, true);
})();
