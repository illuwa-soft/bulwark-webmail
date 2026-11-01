'use client';

import { cn } from '@/lib/utils';
import type { InlineAppState } from '@/hooks/use-sidebar-apps';
import { InlineAppFrame } from './inline-app-frame';

type InlineAppViewProps = {
  apps: InlineAppState[];
  activeAppId: string;
  /** Official release callers retain their host navigation callback; the rail owns invoking it.
   * 공식 릴리스 호출자의 호스트 탐색 콜백을 유지하고 실행은 탐색 레일이 소유합니다. */
  onClose?: () => void;
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
          <InlineAppFrame
            key={app.id}
            app={app}
            active={app.id === activeAppId}
          />
        ))}
      </div>
    </div>
  );
}
