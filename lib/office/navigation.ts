import type { OfficeController } from './controller';

/** Guard app links, browser history and page unload while the editor owns pending changes.
 * 편집기에 미저장 변경이 있으면 앱 링크·브라우저 기록·페이지 종료를 보호합니다. */
export function guardOfficeNavigation(controller: OfficeController, confirm: () => boolean) {
  let leaving = false;
  const active = () => controller.store.getState().phase !== 'idle';
  const unload = (event: BeforeUnloadEvent) => {
    const state = controller.store.getState();
    if (state.dirty || state.phase === 'saving' || state.phase === 'closing') { event.preventDefault(); event.returnValue = ''; }
  };
  const click = (event: MouseEvent) => {
    if (!active() || leaving || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest('a[href]');
    if (!(link instanceof HTMLAnchorElement) || link.target === '_blank' || link.download || link.href === location.href) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    leaving = true;
    void controller.close(confirm).then(allowed => { if (allowed) link.click(); }).finally(() => { leaving = false; });
  };
  const url = location.href;
  const historyState = history.state;
  const pop = (event: PopStateEvent) => {
    if (!active() || leaving) return;
    event.stopImmediatePropagation();
    history.pushState(historyState, '', url);
    leaving = true;
    void controller.close(confirm).then(allowed => { if (allowed) history.back(); }).finally(() => { leaving = false; });
  };
  document.addEventListener('click', click, true);
  window.addEventListener('popstate', pop, true);
  window.addEventListener('beforeunload', unload);
  return () => {
    document.removeEventListener('click', click, true);
    window.removeEventListener('popstate', pop, true);
    window.removeEventListener('beforeunload', unload);
  };
}
