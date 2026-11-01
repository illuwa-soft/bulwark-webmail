'use client';
import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '@/stores/auth-store';
import { isOfficeView, registerOfficeFrame } from '@/lib/eurooffice/lifecycle';
import { cn } from '@/lib/utils';
import type { InlineAppState } from '@/hooks/use-sidebar-apps';

/** Scope Office DOM to the account that mounted it; never flash a retained foreign frame.
 * Office DOM을 생성한 계정에 한정해 보존된 다른 계정 프레임이 표시되지 않게 합니다. */
export function InlineAppFrame({ app, active }: { app: InlineAppState; active: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const currentAccount = useAuthStore((state) => state.activeAccountId);
  const authenticated = useAuthStore((state) => state.isAuthenticated && !!state.client);
  const ownerAccount = useRef(currentAccount);
  const office = typeof window !== 'undefined' && isOfficeView(app.url);
  const visibleToAccount = !office || (authenticated && ownerAccount.current === currentAccount);
  useEffect(() => {
    if (!office || !visibleToAccount || !frame.current?.contentWindow) return;
    return registerOfficeFrame(frame.current.contentWindow, () => setReady(true));
  }, [office, visibleToAccount, app.url]);
  if (!visibleToAccount) return null;
  return <iframe ref={frame} src={app.url} title={app.name} inert={office && !ready}
    className={cn('absolute inset-0 w-full h-full border-0', !active && 'hidden')}
    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
    referrerPolicy="no-referrer" loading="lazy" />;
}
