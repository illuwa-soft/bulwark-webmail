'use client';

import { cn } from '@/lib/utils';
import type { InlineAppState } from '@/hooks/use-sidebar-apps';

type InlineAppViewProps = {
  apps: InlineAppState[];
  activeAppId: string;
  className?: string;
};

/** Give inline apps the full content surface; their own chrome and the navigation rail own closing.
 * 앱 자체 컨트롤·탐색 레일에 닫기를 맡기고 inline 앱에 전체 콘텐츠 영역을 제공합니다. */
export function InlineAppView({ apps, activeAppId, className }: InlineAppViewProps) {
  return (
    <div className={cn('flex flex-col h-full min-h-0 min-w-0 bg-background', className)}>
      {/* Iframes - active one visible, rest hidden but alive */}
      <div className="flex-1 min-h-0 relative">
        {apps.map((app) => (
          <iframe
            key={app.id}
            src={app.url}
            title={app.name}
            className={cn(
              'absolute inset-0 w-full h-full border-0',
              app.id !== activeAppId && 'hidden'
            )}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            loading="lazy"
          />
        ))}
      </div>
    </div>
  );
}
