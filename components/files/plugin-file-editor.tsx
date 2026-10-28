'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from '@/components/icons';
import { PluginIframeSlot } from '@/components/plugins/plugin-iframe-slot';
import { EmbeddedWorkspace } from '@/components/plugins/embedded-workspace';
import { leaveEmbeddedWorkspace } from '@/lib/plugin-embedded/requests';
import { registerFileEditorHost } from '@/lib/plugin-sandbox/file-editors';
import type { FileEditorTarget } from '@/hooks/use-plugin-file-editor';
import { toast } from '@/stores/toast-store';

/** Mounts a provider inside Files; content completion belongs to the provider's opaque leave decision.
 * 파일 화면에 제공자를 마운트하고 내용 완료는 제공자의 불투명한 이탈 결정에 맡깁니다. */
export function PluginFileEditor({ target, onClose }: { target: FileEditorTarget; onClose(): void }) {
  const common = useTranslations('common');
  const frameCopy = useTranslations('plugins.permissions.ui_embedded_view');
  const root = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);

  /** Requests the owner's leave decision without interpreting saves, receipts or document types.
   * 저장·원장·문서 형식을 해석하지 않고 소유자의 이탈 결정을 요청합니다. */
  const close = useCallback(async () => {
    setClosing(true);

    try {
      if (!root.current || !(await leaveEmbeddedWorkspace(target.pluginId, root.current, 'close'))) return false;
      onClose();

      return true;
    } finally {
      setClosing(false);
    }
  }, [onClose, target.pluginId]);

  useEffect(() => {
    if (!root.current) return;

    return registerFileEditorHost({ pluginId: target.pluginId, root: root.current, close });
  }, [target.pluginId, close]);

  return (
    <div ref={root} role="dialog" aria-label={target.file.name} aria-modal="true" className="fixed inset-0 z-[100] flex flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        <span className="truncate text-sm font-medium">{target.file.name}</span>
        <button type="button" aria-label={common('close')} disabled={closing} onClick={() => { void close().catch(() => toast.error(frameCopy('close_failed'))); }} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
          <X className="h-4 w-4" />
        </button>
      </header>
      <EmbeddedWorkspace pluginId={target.pluginId}>
        <PluginIframeSlot pluginId={target.pluginId} slot="file-editor" extraProps={{ file: target.file, accountId: target.accountId }} fill />
      </EmbeddedWorkspace>
    </div>
  );
}
