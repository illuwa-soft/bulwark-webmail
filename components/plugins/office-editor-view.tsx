'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import type { OfficeController } from '../../lib/office/controller';
import { guardOfficeNavigation } from '../../lib/office/navigation';

/** Render a host-owned sibling frame; the document SDK never executes in the mail origin.
 * 문서 SDK가 메일 출처에서 실행되지 않도록 호스트 소유의 형제 프레임을 표시합니다. */
export function OfficeEditorView({ controller }: { controller: OfficeController }) {
  const state = useStore(controller.store);
  const frame = useRef<HTMLIFrameElement>(null);
  const copy = controller.messages;
  const confirmClose = useCallback(() => window.confirm(controller.messages.confirm), [controller]);
  useEffect(() => {
    const receive = (event: MessageEvent) => controller.receive(event, frame.current?.contentWindow ?? null);
    window.addEventListener('message', receive);
    const removeGuard = guardOfficeNavigation(controller, confirmClose);
    const heartbeat = setInterval(() => void controller.heartbeat(), 120_000);
    return () => { window.removeEventListener('message', receive); removeGuard(); clearInterval(heartbeat); };
  }, [controller, confirmClose]);
  if (state.phase === 'idle') return null;
  let label = copy.loading;
  if (state.ready) label = copy.ready;
  if (state.dirty) label = copy.dirty;
  if (state.document?.savedAt && !state.dirty) label = copy.saved;
  if (state.phase === 'saving') label = copy.saving;
  if (state.phase === 'closing') label = copy.closing;
  return (
    <section data-office-host data-editor-ready={state.ready} data-editor-dirty={state.dirty} className="flex flex-1 min-h-0 flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-3">
        <div className="min-w-0"><h1 className="truncate font-semibold">{state.document?.fileName ?? copy.title}</h1><p role="status" className="text-sm text-muted-foreground">{label}</p></div>
        <div className="flex gap-2">
          <button className="rounded border border-border px-3 py-2 disabled:opacity-50" disabled={state.phase === 'opening' || state.phase === 'closing'} onClick={() => void controller.close(confirmClose)}>{copy.back}</button>
          <button className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" disabled={!state.ready || !state.dirty || state.phase === 'saving'} onClick={() => void controller.save()}>{copy.save}</button>
        </div>
      </header>
      {state.error && <p role="alert" className="p-3 text-sm text-destructive">{state.error}</p>}
      {state.phase === 'error' && <div className="flex flex-wrap gap-2 p-3"><button className="rounded border border-border px-3 py-2" onClick={() => void controller.recheck()}>{copy.recheck}</button><button className="rounded border border-destructive px-3 py-2" onClick={() => void controller.abandon(() => window.confirm(copy.abandonConfirm))}>{copy.abandon}</button></div>}
      {state.document && !state.detached && <div className="relative flex flex-1 min-h-0" inert={state.phase === 'saving'}>
        <iframe key={state.channel} ref={frame} title="EuroOffice 문서 편집기" src={state.document.editorUrl} className="h-full w-full flex-1 border-0" sandbox="allow-scripts allow-same-origin allow-forms" allow="clipboard-write" referrerPolicy="no-referrer" />
      </div>}
    </section>
  );
}
