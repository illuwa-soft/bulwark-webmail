'use client';
import { IS_LITE } from '@/lib/lite';

type OfficeFrame = { window: Window; ready: boolean };
const frames = new Set<OfficeFrame>();
const pending = new Map<string, { frame: OfficeFrame; resolve(value: boolean): void }>();

export function isOfficeView(url: string) {
  if (IS_LITE) return false;
  try {
    const target = new URL(url, location.origin);
    return target.origin === location.origin && /\/api\/eurooffice\/view\/\d+\/[A-Za-z0-9_-]{43}(?:\/|$)/.test(target.pathname);
  } catch { return false; }
}

/** Track only the exact owned iframe; a sibling plugin cannot acknowledge another app's close.
 * 정확한 소유 iframe만 추적해 다른 플러그인이 종료를 대신 확인하지 못하게 합니다. */
export function registerOfficeFrame(window: Window, ready: () => void = () => {}) {
  const frame = { window, ready: false };
  frames.add(frame);
  const receive = (event: MessageEvent) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'office-app') return;
    if (event.data.event === 'ready') { frame.ready = true; ready(); }
    if (event.data.event !== 'leave-result' || typeof event.data.requestId !== 'string') return;
    const request = pending.get(event.data.requestId);
    if (request?.frame !== frame) return;
    pending.delete(event.data.requestId);
    request.resolve(event.data.canLeave === true);
  };
  globalThis.window.addEventListener('message', receive);
  return () => {
    frames.delete(frame);
    globalThis.window.removeEventListener('message', receive);
    for (const [id, request] of pending) {
      if (request.frame !== frame) continue;
      pending.delete(id);
      request.resolve(false);
    }
  };
}

export const officeViewsActive = () => frames.size > 0;

async function leaveFrame(frame: OfficeFrame, reason: string) {
  // The host keeps this iframe inert until ready, so no edit can start before the handshake.
  // 호스트가 ready 확인 전 iframe을 inert로 유지하므로 그 전에 편집을 시작할 수 없습니다.
  if (!frame.ready) return true;
  const requestId = crypto.randomUUID();
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await new Promise<boolean>((resolve) => {
      pending.set(requestId, { frame, resolve });
      timer = setTimeout(() => { pending.delete(requestId); resolve(false); }, 120_000);
      frame.window.postMessage({ source: 'office-host', action: 'leave', requestId, reason }, location.origin);
    });
  } finally { clearTimeout(timer!); }
}

/** Confirm the provider's final close before changing accounts, disabling Office or navigating away.
 * 계정 전환·Office 비활성화·이동 전에 제공자의 최종 종료를 확인합니다. */
export async function leaveOfficeViews(reason: string) {
  for (const frame of frames) if (!(await leaveFrame(frame, reason))) return false;
  return true;
}

/** Authentication revocation cannot wait for a renderer; discard outstanding acknowledgements.
 * 인증 폐기는 렌더러를 기다릴 수 없으므로 남은 확인 요청을 폐기합니다. */
export function disposeOfficeViews() {
  for (const request of pending.values()) request.resolve(false);
  pending.clear();
  for (const frame of frames) frame.ready = false;
}
