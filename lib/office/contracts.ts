export const OFFICE_API_PATH = '/api/v1/eurooffice-plugin';

export type OfficeCommand =
  | { action: 'session.open'; fileId: string }
  | { action: 'session.save' | 'session.status' | 'session.end'; sessionId: string };
export type OfficeRequest = (command: OfficeCommand) => Promise<unknown>;
export type OfficeReceipt = {
  sessionId: string;
  state: 'editing' | 'saved' | 'closed' | 'conflict' | 'uncertain';
  savedAt: string | null;
  saveRequestId: string | null;
};
export type OfficeDocument = OfficeReceipt & { fileName: string; editorUrl: string };

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Office response');
  return value as Record<string, unknown>;
}

/** Parse the server's receipt; an editor message can never construct a storage acknowledgement.
 * 서버 원장을 파싱하며 편집기 메시지는 원본 저장 완료를 만들 수 없습니다. */
export function readReceipt(value: unknown, sessionId?: string): OfficeReceipt {
  const data = object(value);
  if (typeof data.sessionId !== 'string' || !/^[\w-]{1,64}$/.test(data.sessionId)) throw new Error('Invalid Office session');
  if (sessionId && data.sessionId !== sessionId) throw new Error('Office session changed');
  if (!['editing', 'saved', 'closed', 'conflict', 'uncertain'].includes(String(data.state))) throw new Error('Invalid Office state');
  if (data.savedAt !== null && (typeof data.savedAt !== 'string' || !Number.isFinite(Date.parse(data.savedAt)))) throw new Error('Invalid Office receipt');
  if (data.saveRequestId !== null && typeof data.saveRequestId !== 'string') throw new Error('Invalid Office save request');
  return data as OfficeReceipt;
}

/** Admit one exact, cross-origin editor document, never an arbitrary navigation URL.
 * 임의 탐색 URL 대신 정확히 허용한 별도 출처의 편집 문서 하나만 허용합니다. */
export function readDocument(value: unknown, hostOrigin: string, allowedOrigins: readonly string[], channel: string): OfficeDocument {
  const receipt = readReceipt(value);
  const data = object(value);
  if (typeof data.fileName !== 'string' || !data.fileName || data.fileName.length > 512) throw new Error('Invalid Office filename');
  if (typeof data.editorUrl !== 'string') throw new Error('Invalid Office frame');
  const url = new URL(data.editorUrl);
  if (url.protocol !== 'https:' || url.origin === hostOrigin || !allowedOrigins.includes(url.origin)) throw new Error('Office requires an approved, separate HTTPS origin');
  if (url.username || url.password || url.search || url.pathname !== `/api/v1/eurooffice/embed/${receipt.sessionId}`) throw new Error('Invalid Office frame path');
  if (!/^#[A-Za-z0-9_-]{40,128}$/.test(url.hash)) throw new Error('Invalid Office bootstrap grant');
  url.hash += `.${channel}`;
  return { ...receipt, fileName: data.fileName, editorUrl: url.href };
}
