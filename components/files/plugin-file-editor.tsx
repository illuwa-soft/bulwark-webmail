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

/** Mounts one provider inside Files; the existing external-frame and save/leave guards remain authoritative.
 * 파일 화면 안에 제공자 하나를 마운트하고 기존 외부 프레임·저장 이탈 검증을 적용합니다. */
export function PluginFileEditor({ target, onClose }: { target: FileEditorTarget; onClose(): Promise<void> }) {
  const t = useTranslations('files');
  const root = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);

  /** A close is a guarded leave, not forced removal of an editor with unsaved changes.
   * 닫기를 저장 전 편집기 강제 제거가 아닌 이탈 확인으로 처리합니다. */
  const close = useCallback(async () => {
    setClosing(true);

    try {
      if (!root.current || !(await leaveEmbeddedWorkspace(target.pluginId, root.current, 'close'))) return false;
      await onClose();

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
        <button type="button" aria-label={t('office_close')} disabled={closing} onClick={() => { void close().catch(() => toast.error(t('office_error'))); }} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
          <X className="h-4 w-4" />
        </button>
      </header>
      <EmbeddedWorkspace pluginId={target.pluginId}>
        <PluginIframeSlot pluginId={target.pluginId} slot="file-editor" extraProps={{ file: target.file, accountId: target.accountId }} fill />
      </EmbeddedWorkspace>
    </div>
  );
}
