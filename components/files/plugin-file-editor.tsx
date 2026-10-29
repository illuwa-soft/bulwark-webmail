'use client';

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { useTranslations } from 'next-intl';
import { X } from '@/components/icons';
import { PluginIframeSlot } from '@/components/plugins/plugin-iframe-slot';
import { PluginActions } from '@/components/plugins/plugin-actions';
import { EmbeddedWorkspace } from '@/components/plugins/embedded-workspace';
import { leaveEmbeddedWorkspace } from '@/lib/plugin-embedded/requests';
import type { LeaveReason } from '@/lib/plugin-embedded/contracts';
import { registerFileEditorHost } from '@/lib/plugin-sandbox/file-editors';
import type { FileEditorTarget } from '@/hooks/use-plugin-file-editor';
import { toast } from '@/stores/toast-store';

export type FileEditorHandle = { requestClose(reason?: LeaveReason): Promise<boolean> };

/** Mount a provider in the native right pane; content completion remains provider-owned.
 * 제공자를 네이티브 오른쪽 패널에 마운트하고 내용 완료는 제공자가 판단합니다. */
export function PluginFileEditor({ target, onClose, ref }: { target: FileEditorTarget; onClose(): void; ref?: Ref<FileEditorHandle> }) {
  const root = useRef<HTMLDivElement>(null);

  /** Ask the exact workspace to finish before closing, navigating or replacing a document.
   * 문서를 닫거나 탐색·교체하기 전에 해당 작업 영역의 완료 승인을 요청합니다. */
  const requestClose = useCallback(async (reason: LeaveReason = 'close') => {
    if (!root.current || !(await leaveEmbeddedWorkspace(target.pluginId, root.current, reason))) return false;
    onClose();
    return true;
  }, [onClose, target.pluginId]);

  useImperativeHandle(ref, () => ({ requestClose }), [requestClose]);
  useEffect(() => {
    if (!root.current) return;
    return registerFileEditorHost({ pluginId: target.pluginId, root: root.current, close: requestClose });
  }, [target.pluginId, requestClose]);

  return (
    <section ref={root} role="region" aria-label={target.file.name} data-file-editor-instance={target.instanceId} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <EmbeddedWorkspace pluginId={target.pluginId} frameless>
        <PluginIframeSlot pluginId={target.pluginId} slot="file-editor" extraProps={{ file: target.file, accountId: target.accountId }} fill />
      </EmbeddedWorkspace>
    </section>
  );
}

/** Dock controls outside the canvas; provider actions remain bound to their exact declaring frame.
 * 캔버스 밖에 컨트롤을 배치하고 제공자 액션은 선언한 프레임에 정확히 결합합니다. */
export function PluginFileEditorControls({ target, onClose }: { target: FileEditorTarget; onClose(): Promise<boolean> }) {
  const common = useTranslations('common');
  const copy = useTranslations('plugins.permissions.ui_embedded_view');
  const [closing, setClosing] = useState(false);

  /** Keep host-owned exit feedback generic while awaiting the provider's opaque decision.
   * 제공자의 불투명한 승인을 기다리며 호스트 종료 안내를 범용으로 유지합니다. */
  const close = async () => {
    setClosing(true);
    try {
      await onClose();
    } catch {
      toast.error(copy('close_failed'));
    } finally {
      setClosing(false);
    }
  };

  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
      <PluginActions surface="file-editor-actions" instanceId={target.instanceId} context={{ file: target.file, accountId: target.accountId }} compact className="max-w-full" />
      <button type="button" aria-label={common('close')} title={common('close')} disabled={closing} onClick={() => { void close(); }} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
