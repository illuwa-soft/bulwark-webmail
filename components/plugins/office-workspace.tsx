'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { useLocale } from 'next-intl';
import { useAuthStore } from '@/stores/auth-store';
import { createOfficeController } from '@/lib/office/controller';
import { registerOfficeHost } from '@/lib/office/requests';
import { OfficeEditorView } from './office-editor-view';

/** Keep the document library mounted while the app, outside its sandbox, owns the editor.
 * 문서함을 마운트한 채 샌드박스 바깥의 앱이 편집기를 소유합니다. */
export function OfficeWorkspace({ pluginId, children }: { pluginId: string; children: ReactNode }) {
  const locale = useLocale();
  const accountId = useAuthStore(state => state.activeAccountId);
  const identity = useRef(accountId);
  identity.current = accountId;
  const [controller] = useState(() => createOfficeController(() => identity.current ?? '', { locale }));
  const active = useStore(controller.store, state => state.phase !== 'idle');
  useEffect(() => {
    const remove = registerOfficeHost({
      pluginId,
      active: () => controller.store.getState().phase !== 'idle',
      open: input => controller.open(input),
      dispose: () => controller.dispose(),
      leave: () => controller.close(() => window.confirm(controller.messages.confirm)),
    });
    return () => { remove(); controller.dispose(); };
  }, [controller, pluginId, accountId]);
  return <><div className="flex flex-1 min-h-0 flex-col" hidden={active} inert={active} style={active ? { display: 'none' } : undefined}>{children}</div><OfficeEditorView controller={controller} /></>;
}
