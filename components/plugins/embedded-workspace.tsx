'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { useAuthStore } from '@/stores/auth-store';
import { createEmbeddedViewController } from '@/lib/plugin-embedded/controller';
import { registerEmbeddedViewHost } from '@/lib/plugin-embedded/requests';
import { EmbeddedView } from './embedded-view';

/** Keep the sandbox mounted while its approved external view occupies the host page. */
export function EmbeddedWorkspace({ pluginId, children }: { pluginId: string; children: ReactNode }) {
  const accountId = useAuthStore(state => state.activeAccountId);
  const identity = useRef(accountId);
  identity.current = accountId;
  const page = useRef<HTMLDivElement>(null);
  const [controller] = useState(() => createEmbeddedViewController(() => identity.current ?? ''));
  const hidden = useStore(controller.store, state => !!state.view && !state.detached);
  useEffect(() => {
    if (page.current) return registerEmbeddedViewHost({ pluginId, controller, root: page.current });
  }, [controller, pluginId, accountId]);
  return <><div ref={page} className="flex flex-1 min-h-0 flex-col" hidden={hidden} inert={hidden} style={hidden ? { display: 'none' } : undefined}>{children}</div><EmbeddedView controller={controller} /></>;
}
