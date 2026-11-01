import { JMAPClient } from '@/lib/jmap/client';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

export type OfficeAccount = { id: string; slot: number; subject: string; origin: string };

/** Fence selection with the canonical authenticated JMAP Session, never a login/sending label.
 * 로그인·발신자 표시명이 아닌 인증한 JMAP Session 정본으로 선택 범위를 제한합니다. */
export function officeAccount(client: IJMAPClient | null, id: string | null, slot: number | undefined): OfficeAccount | null {
  if (!(client instanceof JMAPClient) || !id || slot === undefined) return null;
  const subject = client.getSessionUsername();
  if (!subject) return null;
  return { id, slot, subject, origin: new URL(client.getServerUrl()).origin };
}

/** Detect stale UI handlers without treating the expected identity as authorization.
 * 예상 주체를 인증 근거로 사용하지 않고 오래된 UI 조작만 거부합니다. */
export function sameOfficeAccount(expected: OfficeAccount, client: IJMAPClient | null, id: string | null) {
  const current = officeAccount(client, id, expected.slot);
  return current !== null && current.id === expected.id && current.subject === expected.subject && current.origin === expected.origin;
}
