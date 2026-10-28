'use client';

import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { useTranslations } from 'next-intl';
import type { EmbeddedViewController } from '@/lib/plugin-embedded/controller';
import { guardEmbeddedNavigation } from '@/lib/plugin-embedded/navigation';

/** A provider-neutral frame with a host-owned exit; application controls live in the plugin. */
export function EmbeddedView({ controller }: { controller: EmbeddedViewController }) {
  const state = useStore(controller.store);
  const frame = useRef<HTMLIFrameElement>(null);
  const common = useTranslations('common');
  const copy = useTranslations('plugins.permissions.ui_embedded_view');
  useEffect(() => {
    const receive = (event: MessageEvent) => controller.receive(event);
    window.addEventListener('message', receive);
    const remove = guardEmbeddedNavigation(controller);
    return () => { window.removeEventListener('message', receive); remove(); };
  }, [controller]);
  if (!state.view) return null;
  const close = () => {
    if (state.leaveFailed && window.confirm(copy('force_close'))) { controller.dispose(); return; }
    void controller.leave('close');
  };
  return <section data-embedded-view className={`flex min-h-0 flex-col bg-background text-foreground ${state.detached ? 'shrink-0' : 'flex-1'}`}>
    <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
      <h1 className="min-w-0 truncate font-semibold">{state.view.title}</h1>
      <button className="shrink-0 rounded border border-border px-3 py-2" onClick={close}>{common('close')}</button>
    </header>
    {state.leaveFailed && <p role="alert" className="p-3 text-sm">{copy('close_failed')}</p>}
    {!state.detached && <iframe key={state.view.id} ref={frame} title={state.view.title} src={state.view.url} onLoad={() => controller.bindFrame(frame.current?.contentWindow ?? null)} className="h-full w-full flex-1 border-0" sandbox="allow-scripts allow-same-origin allow-forms" allow="clipboard-write" referrerPolicy="no-referrer" />}
  </section>;
}
