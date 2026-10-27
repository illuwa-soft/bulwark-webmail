import type { EmbeddedViewController } from './controller';

/** SPA navigation may wait for a plugin reply; browser unload can only warn. */
export function guardEmbeddedNavigation(controller: EmbeddedViewController) {
  let leaving = false;
  const active = () => !!controller.store.getState().view;
  const unload = (event: BeforeUnloadEvent) => {
    if (controller.store.getState().preventUnload) { event.preventDefault(); event.returnValue = ''; }
  };
  const click = (event: MouseEvent) => {
    if (!active() || leaving || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest('a[href]');
    if (!(link instanceof HTMLAnchorElement) || link.target === '_blank' || link.download || link.href === location.href) return;
    event.preventDefault(); event.stopImmediatePropagation(); leaving = true;
    void controller.leave('navigation').then(allowed => { if (allowed) link.click(); }).finally(() => { leaving = false; });
  };
  const url = location.href;
  const historyState = history.state;
  const pop = (event: PopStateEvent) => {
    if (!active() || leaving) return;
    event.stopImmediatePropagation(); history.pushState(historyState, '', url); leaving = true;
    void controller.leave('navigation').then(allowed => { if (allowed) history.back(); }).finally(() => { leaving = false; });
  };
  document.addEventListener('click', click, true);
  window.addEventListener('popstate', pop, true);
  window.addEventListener('beforeunload', unload);
  return () => { document.removeEventListener('click', click, true); window.removeEventListener('popstate', pop, true); window.removeEventListener('beforeunload', unload); };
}
