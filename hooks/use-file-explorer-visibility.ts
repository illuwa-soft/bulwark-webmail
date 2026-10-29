'use client';

import { useEffect, useState } from 'react';

const EXPLORER_KEY = 'files-explorer-collapsed';

/** Read only the pane preference; folder expansion and the user's width have separate owners.
 * 폴더 펼침·사용자 너비와 분리된 탐색기 패널 표시 설정만 읽습니다. */
function loadFolded(): boolean {
  try {
    return localStorage.getItem(EXPLORER_KEY) === '1';
  } catch {
    return false;
  }
}

/** Keep a usable rail while the mobile tree overlays the document or the desktop tree is folded.
 * 모바일 트리는 문서 위에 겹치고 데스크톱 트리는 접어도 접근 가능한 레일을 유지합니다. */
export function fileExplorerWidth(folded: boolean, narrow: boolean, preferredWidth: number): number {
  if (folded) return 40;
  if (narrow) return 288;
  return preferredWidth;
}

/** Own pane visibility only; folding never navigates, disposes an editor, or reads file content.
 * 패널 표시만 소유하고 접기 동작은 탐색·편집기 해제·파일 본문 조회를 하지 않습니다. */
export function useFileExplorerVisibility(narrow: boolean, currentPath: string) {
  const [visibility, setVisibility] = useState(() => ({ folded: loadFolded(), drawerOpen: false }));

  useEffect(() => {
    setVisibility(current => {
      if (!current.drawerOpen) return current;
      return { ...current, drawerOpen: false };
    });
  }, [narrow, currentPath]);

  /** Dismiss only the mobile tree after navigation or its backdrop click.
   * 탐색·배경 클릭 뒤 모바일 트리만 닫습니다. */
  const closeDrawer = () => setVisibility(current => ({ ...current, drawerOpen: false }));
  /** Persist desktop folding, or toggle the mobile drawer, without a document lifecycle call.
   * 문서 수명 API를 호출하지 않고 데스크톱 접기를 저장하거나 모바일 트리를 전환합니다. */
  const toggleExplorer = () => {
    if (narrow) {
      setVisibility(current => ({ ...current, drawerOpen: !current.drawerOpen }));
      return;
    }
    const folded = !visibility.folded;
    try { localStorage.setItem(EXPLORER_KEY, String(Number(folded))); } catch { /* A storage denial must not disable the control. */ }
    setVisibility(current => ({ ...current, folded }));
  };

  return { ...visibility, closeDrawer, toggleExplorer };
}
