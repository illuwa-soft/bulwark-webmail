'use client';

import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { useTranslations } from 'next-intl';
import type { EmbeddedViewController } from '@/lib/plugin-embedded/controller';
import { guardEmbeddedNavigation } from '@/lib/plugin-embedded/navigation';

/** Host-owned authority chrome; the external page supplies its own application UI. */
export function EmbeddedView({ controller }: { controller: EmbeddedViewController }) {
  const state = useStore(controller.store);
  const frame = useRef<HTMLIFrameElement>(null);
  const common = useTranslations('common');
  const copy = useTranslations('plugins.embedded_view');
  useEffect(() => {
    const receive = (event: MessageEvent) => controller.receive(event);
    window.addEventListener('message', receive);
    const remove = guardEmbeddedNavigation(controller);
    return () => { window.removeEventListener('message', receive); remove(); };
  }, [controller]);
  if (!state.view) return null;
  return <section data-embedded-view className={`flex min-h-0 min-w-0 flex-col bg-background text-foreground ${state.detached ? 'shrink-0' : 'flex-1'}`}>
    <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
      <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{state.view.title}</h1>
      <button className="min-h-11 min-w-11 shrink-0 rounded border border-border px-3 py-2" onClick={() => void controller.leave('close')}>{common('close')}</button>
    </header>
    {state.leaveFailed && <div className="flex shrink-0 flex-wrap items-center gap-2 p-3 text-sm"><p role="alert">{copy('close_failed')}</p><button className="min-h-11 rounded border border-border px-3 py-2" onClick={() => { if (window.confirm(copy('force_close'))) controller.dispose(); }}>{copy('close_without_waiting')}</button></div>}
    {!state.detached && <div className="relative flex min-h-0 min-w-0 flex-1">
      <iframe key={state.view.id} ref={frame} title={state.view.title} src={state.view.url} onLoad={() => controller.bindFrame(frame.current?.contentWindow ?? null)} className="h-full min-h-0 w-full flex-1 border-0" sandbox="allow-scripts allow-same-origin allow-forms" referrerPolicy="no-referrer" />
    </div>}
  </section>;
}
