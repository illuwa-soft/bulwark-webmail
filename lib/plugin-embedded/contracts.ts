/** Host-created identity of the exact sandbox instance and its mounted page. */
export type EmbeddedViewOwner = { readonly slot: string | null; readonly signal: AbortSignal; readonly container: Element };
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type LeaveReason = 'navigation' | 'account-switch' | 'logout' | 'close';
export type EmbeddedViewCommand =
  | { action: 'open'; url: string; title: string }
  | { action: 'next' | 'close'; id: string }
  | { action: 'post'; id: string; data: JsonValue }
  | { action: 'update'; id: string; detached?: true; preventUnload?: boolean }
  | { action: 'reply'; id: string; requestId: string; allow: boolean };
export type EmbeddedViewEvent =
  | { type: 'idle' }
  | { type: 'loaded' }
  | { type: 'message'; data: JsonValue }
  | { type: 'overflow'; dropped: number }
  | { type: 'leave'; requestId: string; reason: LeaveReason };
export type FramePolicy = { hostOrigin: string; frameOrigins: readonly string[]; framePaths: readonly string[] };

/** Normalize bounded JSON without retaining arbitrary structured-clone objects. */
export function frameJson(value: unknown): JsonValue {
  const text = JSON.stringify(value, (_key, entry) => {
    const type = typeof entry;
    if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint' || (type === 'number' && !Number.isFinite(entry))) throw new Error('Expected JSON message data');
    return entry;
  });
  if (!text || text.length > 65_536) throw new Error('Embedded message exceeds size limit');
  return JSON.parse(text) as JsonValue;
}

/** Exact launch paths or trailing-slash prefixes; no URL or traversal syntax. */
export function sanitizeFramePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((path): path is string => typeof path === 'string' && path.length <= 512 && /^\/(?!\/)[A-Za-z0-9._/-]*$/.test(path) && !/(?:^|\/)\.{1,2}(?:\/|$)/.test(path) && !path.includes('//')))].slice(0, 32);
}

export function readEmbeddedUrl(value: string, policy: FramePolicy): string {
  if (value.length > 8192) throw new Error('Embedded URL exceeds size limit');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin === policy.hostOrigin || !policy.frameOrigins.includes(url.origin) || url.username || url.password) throw new Error('Embedded view requires an approved separate HTTPS origin');
  if (/%2f|%5c|%2e|\\/i.test(url.pathname)) throw new Error('Invalid embedded path');
  const allowed = sanitizeFramePaths(policy.framePaths).some(path => path === url.pathname || (path.endsWith('/') && url.pathname.startsWith(path)));
  if (!allowed) throw new Error('Embedded launch path is not declared in framePaths');
  return url.href;
}

/** Commands are sealed; callers cannot supply headers, scripts or sandbox flags. */
export function readEmbeddedCommand(value: unknown): EmbeddedViewCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid embedded view command');
  const data = value as Record<string, unknown>;
  const fields: Record<string, string[]> = {
    open: ['action', 'url', 'title'], next: ['action', 'id'], close: ['action', 'id'],
    post: ['action', 'id', 'data'], update: ['action', 'id', 'detached', 'preventUnload'], reply: ['action', 'id', 'requestId', 'allow'],
  };
  const keys = typeof data.action === 'string' && Object.hasOwn(fields, data.action) ? fields[data.action] : null;
  if (!keys || Object.keys(data).some(key => !keys.includes(key))) throw new Error('Invalid embedded view command fields');
  if (data.action === 'open') {
    if (typeof data.url !== 'string' || typeof data.title !== 'string' || !data.title.trim() || data.title.length > 256) throw new Error('Embedded view requires url and title');
  } else if (typeof data.id !== 'string' || !/^[\w-]{1,64}$/.test(data.id)) throw new Error('Invalid embedded view id');
  if (data.action === 'post') frameJson(data.data);
  if (data.action === 'update' && ((data.detached !== undefined && data.detached !== true) || (data.preventUnload !== undefined && typeof data.preventUnload !== 'boolean'))) throw new Error('Invalid embedded view state');
  if (data.action === 'reply' && (typeof data.requestId !== 'string' || !/^[\w-]{1,64}$/.test(data.requestId) || typeof data.allow !== 'boolean')) throw new Error('Invalid leave response');
  return data as EmbeddedViewCommand;
}
