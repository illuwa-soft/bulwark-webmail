// Buttons and menu entries plugins declare as data (`api.ui.setActions`).
// The host draws them in its own style on the surface named in the slot
// catalogue (kind: 'action'); a click goes back to the plugin with the
// surface's context, filtered by the plugin's permissions.

import { slotSpec } from '../plugin-slot-catalog';
import { isAllowedPluginCombo } from './shortcuts';
import type { EmbeddedViewOwner } from '../plugin-embedded/contracts';

export interface PluginAction {
  id: string;
  label: string;
  /** Name of a host icon (see components/icons); unknown names show none. */
  icon?: string;
  /** Lower comes first; default 100. */
  order?: number;
  /** Show only for these folder roles (message surfaces), e.g. ["inbox"]. */
  mailboxRoles?: string[];
  /** Show only for attachments or files of these MIME types (prefix match, "image/"). */
  mimeTypes?: string[];
  /** Explicit extensions for a file-open-actions provider, without the leading dot. */
  fileExtensions?: string[];
  /** A danger action is drawn in red. */
  danger?: boolean;
  /** A temporarily unavailable control remains visible without being actionable. */
  disabled?: boolean;
  /**
   * A key combination for the action ("Ctrl+Shift+A"), on surfaces that bind
   * one (composer-toolbar-actions: while the composer has focus). Needs Alt,
   * Ctrl/Cmd+Shift or Ctrl/Cmd+Alt, like plugin shortcuts.
   */
  shortcut?: string;
  /**
   * On menu surfaces (the composer's Options and Send menus): draw the entry
   * as a check item, ticked or not. The plugin updates it with setActions.
   */
  checked?: boolean;
  /** A second line under the label, on menu surfaces. Up to 120 characters. */
  description?: string;
}

export interface RegisteredAction extends PluginAction {
  pluginId: string;
  pluginName: string;
  /** Host-only frame identity; never accepted from action JSON. */
  owner?: EmbeddedViewOwner;
  instanceId?: string;
}

export const MAX_ACTIONS_PER_SURFACE = 8;
const ID_RE = /^[a-z0-9][a-z0-9-_.]{0,39}$/i;
const ICON_RE = /^[A-Za-z0-9-]{1,40}$/;
const ROLE_RE = /^[a-z]{1,20}$/;
const MIME_RE = /^[a-z0-9.+-]+\/[a-z0-9.+*-]*$/i;

/** Surfaces that take actions, from the slot catalogue. */
export function isActionSurface(surface: string): boolean {
  return slotSpec(surface)?.kind === 'action';
}

/** Check and copy what a plugin sent; throws with a message the plugin sees. */
export function checkActions(value: unknown): PluginAction[] {
  if (!Array.isArray(value)) throw new Error('actions must be a list');
  if (value.length > MAX_ACTIONS_PER_SURFACE) throw new Error(`At most ${MAX_ACTIONS_PER_SURFACE} actions per surface`);
  const seen = new Set<string>();
  return value.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new Error(`actions[${i}] must be an object`);
    const a = raw as Record<string, unknown>;
    if (typeof a.id !== 'string' || !ID_RE.test(a.id)) throw new Error(`actions[${i}].id is invalid`);
    if (seen.has(a.id)) throw new Error(`actions[${i}].id is used twice`);
    seen.add(a.id);
    if (typeof a.label !== 'string' || !a.label.trim() || a.label.length > 60) throw new Error(`actions[${i}].label is required (max 60 characters)`);
    const out: PluginAction = { id: a.id, label: a.label.trim() };
    if (a.icon !== undefined) {
      if (typeof a.icon !== 'string' || !ICON_RE.test(a.icon)) throw new Error(`actions[${i}].icon is invalid`);
      out.icon = a.icon;
    }
    if (a.order !== undefined) {
      if (typeof a.order !== 'number' || !Number.isFinite(a.order)) throw new Error(`actions[${i}].order must be a number`);
      out.order = a.order;
    }
    if (a.mailboxRoles !== undefined) {
      if (!Array.isArray(a.mailboxRoles) || a.mailboxRoles.length > 10 || !a.mailboxRoles.every((r) => typeof r === 'string' && ROLE_RE.test(r))) {
        throw new Error(`actions[${i}].mailboxRoles must be a list of folder roles`);
      }
      out.mailboxRoles = [...a.mailboxRoles] as string[];
    }
    if (a.mimeTypes !== undefined) {
      if (!Array.isArray(a.mimeTypes) || a.mimeTypes.length > 20 || !a.mimeTypes.every((m) => typeof m === 'string' && MIME_RE.test(m))) {
        throw new Error(`actions[${i}].mimeTypes must be a list of MIME types`);
      }
      out.mimeTypes = (a.mimeTypes as string[]).map((m) => m.toLowerCase());
    }
    if (a.fileExtensions !== undefined) {
      if (!Array.isArray(a.fileExtensions) || a.fileExtensions.length === 0 || a.fileExtensions.length > 20 || !a.fileExtensions.every((extension) => typeof extension === 'string' && /^[a-z0-9]{1,12}$/i.test(extension))) {
        throw new Error(`actions[${i}].fileExtensions must name at most 20 file extensions`);
      }
      out.fileExtensions = a.fileExtensions.map((extension: string) => extension.toLowerCase());
    }
    if (a.danger !== undefined) out.danger = a.danger === true;
    if (a.disabled !== undefined) {
      if (typeof a.disabled !== 'boolean') throw new Error(`actions[${i}].disabled must be true or false`);
      out.disabled = a.disabled;
    }
    if (a.checked !== undefined) {
      if (typeof a.checked !== 'boolean') throw new Error(`actions[${i}].checked must be true or false`);
      out.checked = a.checked;
    }
    if (a.description !== undefined) {
      if (typeof a.description !== 'string' || a.description.length > 120) throw new Error(`actions[${i}].description must be a string of up to 120 characters`);
      if (a.description.trim()) out.description = a.description.trim();
    }
    if (a.shortcut !== undefined) {
      if (typeof a.shortcut !== 'string' || a.shortcut.length > 30 || !isAllowedPluginCombo(a.shortcut)) {
        throw new Error(`actions[${i}].shortcut must use Alt, Ctrl+Shift or Ctrl+Alt`);
      }
      out.shortcut = a.shortcut;
    }
    return out;
  });
}

// pluginId → surface → actions
const registry = new Map<string, Map<string, RegisteredAction[]>>();
const listeners = new Set<() => void>();
const snapshots = new Map<string, RegisteredAction[]>();
const frameActions = new Map<EmbeddedViewOwner, RegisteredAction[]>();
const observedOwners = new WeakSet<EmbeddedViewOwner>();

function changed(): void {
  snapshots.clear();
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
}

export function subscribeActions(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setPluginActions(pluginId: string, pluginName: string, surface: string, actions: PluginAction[]): void {
  let surfaces = registry.get(pluginId);
  if (!surfaces) {
    surfaces = new Map();
    registry.set(pluginId, surfaces);
  }
  if (actions.length === 0) surfaces.delete(surface);
  else surfaces.set(surface, actions.map((a) => ({ ...a, pluginId, pluginName })));
  changed();
}

/** Bind editor controls to their native workspace and remove only that frame's declarations on abort.
 * 편집 컨트롤을 네이티브 작업 영역에 결합하고 해제 시 해당 프레임의 선언만 제거합니다. */
export function setFileEditorActions(pluginId: string, pluginName: string, actions: PluginAction[], owner: EmbeddedViewOwner | undefined): void {
  const instanceId = owner?.container.closest('[data-file-editor-instance]')?.getAttribute('data-file-editor-instance');
  if (!owner || owner.slot !== 'file-editor' || owner.signal.aborted || !owner.invokeAction || !instanceId) {
    throw new Error('File editor actions require their exact live native workspace');
  }
  if (!observedOwners.has(owner)) {
    observedOwners.add(owner);
    owner.signal.addEventListener('abort', () => {
      if (frameActions.delete(owner)) changed();
    }, { once: true });
  }
  if (actions.length === 0) frameActions.delete(owner);
  if (actions.length > 0) frameActions.set(owner, actions.map(action => ({ ...action, pluginId, pluginName, owner, instanceId })));
  changed();
}

/** Drop a removed plugin's global and frame declarations without touching other providers.
 * 제거된 플러그인의 전역·프레임 선언만 정리하고 다른 제공자는 유지합니다. */
export function clearPluginActions(pluginId: string): void {
  const owners = [...frameActions].filter(([, actions]) => actions.some(action => action.pluginId === pluginId)).map(([owner]) => owner);
  for (const owner of owners) frameActions.delete(owner);
  const removed = registry.delete(pluginId);
  if (removed || owners.length > 0) changed();
}

/**
 * The actions on a surface, in order. The same array is returned until
 * something changes, so it can feed useSyncExternalStore.
 */
export function actionsFor(surface: string): RegisteredAction[] {
  const cached = snapshots.get(surface);
  if (cached) return cached;
  const out: RegisteredAction[] = [];
  for (const surfaces of registry.values()) out.push(...(surfaces.get(surface) ?? []));
  if (surface === 'file-editor-actions') {
    for (const actions of frameActions.values()) out.push(...actions);
  }
  out.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label));
  snapshots.set(surface, out);
  return out;
}

/** Whether an action applies to a folder role and/or a MIME type. */
export function actionApplies(action: PluginAction, ctx: { mailboxRole?: string | null; mimeType?: string | null; fileName?: string | null }): boolean {
  if (action.fileExtensions && ctx.fileName !== undefined && !action.fileExtensions.includes((ctx.fileName ?? '').split('.').at(-1)?.toLowerCase() ?? '')) return false;
  if (action.mailboxRoles && ctx.mailboxRole !== undefined && !action.mailboxRoles.includes(ctx.mailboxRole ?? '')) return false;
  if (action.mimeTypes && ctx.mimeType !== undefined) {
    const type = (ctx.mimeType ?? '').toLowerCase();
    if (!action.mimeTypes.some((m) => (m.endsWith('/') || m.endsWith('/*') ? type.startsWith(m.replace(/\*$/, '')) : type === m))) return false;
  }
  return true;
}

/** Test helper. */
export function resetActions(): void {
  registry.clear();
  frameActions.clear();
  changed();
}

// ─── Clicks ───────────────────────────────────────────────────

/**
 * Delivers a click to the plugin. Set by the loader, which owns the running
 * plugins; it filters `context` by the surface's props and the plugin's
 * permissions before anything crosses into the sandbox.
 */
export type ActionDispatcher = (pluginId: string, surface: string, actionId: string, context: Record<string, unknown>) => Promise<void>;

let dispatcher: ActionDispatcher | null = null;

export function setActionDispatcher(next: ActionDispatcher | null): void {
  dispatcher = next;
}

/** Run only a current enabled declaration; frame controls target their exact owning instance.
 * 현재 활성 선언만 실행하고 프레임 컨트롤은 정확한 소유 인스턴스에 전달합니다. */
export async function runAction(action: RegisteredAction, surface: string, context: Record<string, unknown>): Promise<void> {
  if (action.disabled) return;
  if (action.owner) {
    if (surface !== 'file-editor-actions' || action.owner.signal.aborted || !frameActions.get(action.owner)?.includes(action)) return;
    await action.owner.invokeAction?.(surface, action.id, context);
    return;
  }
  if (!dispatcher) return;
  await dispatcher(action.pluginId, surface, action.id, context);
}
