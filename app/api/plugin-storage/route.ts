import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { configManager } from '@/lib/admin/config-manager';
import { getPlugin } from '@/lib/admin/plugin-registry';
import { listApprovals } from '@/lib/admin/plugin-approvals';
import { readStalwartAuthContextFromStore } from '@/lib/stalwart/auth-context';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { getSessionSecret } from '@/lib/auth/session-secret';
import { pluginDataOperation } from '@/lib/plugin-data/store';
import { MAX_PERSISTENT_REQUEST_BYTES, PERSISTENT_READ_PERMISSION, PERSISTENT_WRITE_PERMISSION, PersistentStorageError, persistentRequest } from '@/lib/plugin-persistent-storage';
import type { PluginDataOwner } from '@/lib/plugin-data/store';
import type { StorageErrorCode } from '@/lib/plugin-persistent-storage';

const NO_STORE = { 'cache-control': 'no-store' };
const ERROR_STATUS: Record<StorageErrorCode, number> = { invalid: 400, conflict: 409, quota: 413, busy: 503, unavailable: 503 };

/** Decodes host-owned identity headers without excluding international account names.
 * 국제화 계정 이름을 배제하지 않고 호스트 소유 식별 헤더를 디코딩합니다. */
function identityHeader(value: string | null): string | null {
  if (!value) return null;
  try { return decodeURIComponent(value); }
  catch { return null; }
}

/** Uses only an authenticated cookie slot, matching the captured host client before choosing an owner.
 * 호스트가 캡처한 클라이언트와 일치하는 인증 쿠키 슬롯으로만 저장 주체를 결정합니다. */
async function currentOwner(request: NextRequest): Promise<PluginDataOwner | null> {
  const rawSlot = request.headers.get('X-JMAP-Cookie-Slot') ?? '';
  if (!/^\d+$/.test(rawSlot)) return null;
  const slot = Number(rawSlot);
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_ACCOUNT_SLOTS) return null;
  const context = readStalwartAuthContextFromStore(await cookies(), slot);
  if (!context) return null;
  const serverUrl = context.serverUrl.replace(/\/+$/, '');
  if (identityHeader(request.headers.get('X-JMAP-Username')) !== context.username || identityHeader(request.headers.get('X-JMAP-Server')) !== serverUrl) return null;
  if (!context.accountName && context.authHeader.startsWith('Bearer ') && !context.username.includes('@')) return null;
  return { accountName: context.accountName ?? context.username, serverUrl };
}

/** Rechecks the exact installed/approved package on the server, including revoked permissions.
 * 서버에서 권한 철회 여부를 포함해 설치·승인된 정확한 패키지를 재확인합니다. */
async function permitted(pluginId: string, fingerprint: string, permission: string): Promise<boolean> {
  const installed = await getPlugin(pluginId);
  if (installed) return installed.enabled && installed.bundleHash === fingerprint && installed.permissions.includes(permission);
  if (!configManager.getPolicy().features.pluginsUploadEnabled) return false;
  const approved = (await listApprovals()).find(entry => entry.pluginId === pluginId && entry.bundleHash === fingerprint);
  return approved?.status === 'approved' && approved.manifest.permissions?.includes(permission) === true;
}

/** Bounds incoming bytes while streaming, before JSON parsing or any disk allocation.
 * JSON 파싱·디스크 할당 전에 스트림을 읽으며 입력 바이트를 제한합니다. */
async function readBody(request: NextRequest): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new PersistentStorageError('invalid');
  if (Number(request.headers.get('content-length') ?? 0) > MAX_PERSISTENT_REQUEST_BYTES) throw new PersistentStorageError('quota');
  if (!request.body) throw new PersistentStorageError('invalid');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PERSISTENT_REQUEST_BYTES) throw new PersistentStorageError('quota');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); }
  catch { throw new PersistentStorageError('invalid'); }
}

/** Returns stable public codes with no account names, paths, credentials or stored values.
 * 계정 이름·경로·자격증명·저장 값을 제외한 안정적인 공개 코드를 반환합니다. */
function problem(code: string, status: number) {
  return NextResponse.json({ error: { code } }, { status, headers: NO_STORE });
}

/** One same-origin endpoint owns the plugin namespace; callers cannot select an account in the body.
 * 동일 출처 엔드포인트가 플러그인 네임스페이스를 소유하며 본문으로 계정을 선택할 수 없습니다. */
export async function POST(request: NextRequest) {
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  await configManager.ensureLoaded();
  if (!configManager.getPolicy().features.pluginsEnabled) return problem('forbidden', 403);
  if (getSessionSecret().length < 32) return problem('unavailable', 503);
  const owner = await currentOwner(request);
  if (!owner) return problem('unauthenticated', 401);
  const pluginId = request.headers.get('X-Bulwark-Plugin-Id') ?? '';
  const fingerprint = request.headers.get('X-Bulwark-Plugin-Fingerprint') ?? '';
  if (!/^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$/.test(pluginId) || !/^[a-f0-9]{64}$/.test(fingerprint)) return problem('invalid', 400);
  try {
    const input = persistentRequest(await readBody(request));
    let permission: string = PERSISTENT_READ_PERMISSION;
    if (input.operation === 'set' || input.operation === 'remove') permission = PERSISTENT_WRITE_PERMISSION;
    if (!await permitted(pluginId, fingerprint, permission)) return problem('forbidden', 403);
    const result = await pluginDataOperation(owner, pluginId, input);
    return NextResponse.json({ result }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof PersistentStorageError) return problem(error.code, ERROR_STATUS[error.code]);
    return problem('unavailable', 503);
  }
}
