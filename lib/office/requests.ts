import type { OfficeReceipt } from './contracts';
import type { OpenOffice } from './controller';

type Host = { pluginId: string; active(): boolean; open(input: OpenOffice): Promise<OfficeReceipt | null>; leave(): Promise<boolean>; dispose(): void };
const hosts = new Set<Host>();
export function officeIsActive() { return [...hosts].some(host => host.active()); }

/** Bind requests to a mounted host-owned page, never to an arbitrary plugin frame.
 * 임의 플러그인 프레임 대신 마운트된 호스트 소유 페이지에 요청을 결합합니다. */
export function registerOfficeHost(host: Host) {
  hosts.add(host);
  return () => { hosts.delete(host); };
}
export function requestOfficeEditor(input: OpenOffice) {
  const host = [...hosts].find(candidate => candidate.pluginId === input.pluginId);
  if (!host) throw new Error('Open the Office app page first');
  return host.open(input);
}
/** Finish or cancel editing before account switching, logout, or app navigation.
 * 계정 전환·로그아웃·앱 탐색 전에 편집 종료 또는 취소를 확인합니다. */
export async function leaveOffice() {
  for (const host of hosts) if (!(await host.leave())) return false;
  return true;
}

/** An expired or revoked login must never wait for an editor confirmation.
 * 만료되거나 취소된 로그인은 편집기 확인 때문에 유지되지 않습니다. */
export function disposeOffice() { for (const host of hosts) host.dispose(); }
