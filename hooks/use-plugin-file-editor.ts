'use client';

import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { actionsFor, subscribeActions } from '@/lib/plugin-sandbox/actions';
import { findFileEditor } from '@/lib/plugin-sandbox/file-editors';
import type { FileResourceView } from '@/lib/plugin-types';
import { IS_LITE } from '@/lib/lite';
import { resourceServerRef, resourceToView, useFileStore } from '@/stores/file-store';

export type FileEditorTarget = {
  instanceId: string;
  resourceId: string;
  pluginId: string;
  ownerId: string | null;
  accountId: string;
  file: FileResourceView;
};

/** Supplies a cached registry snapshot for React subscriptions.
 * React 구독에 레지스트리의 안정적인 스냅샷을 제공합니다. */
const fileOpeners = () => actionsFor('file-open-actions');

/** Owns only an editor selection; files, navigation and CRUD stay in the native store.
 * 편집기 선택만 소유하고 파일·탐색·CRUD는 네이티브 스토어에 둡니다. */
export function usePluginFileEditor(ownerId: string | null, requestLeave?: () => Promise<boolean>) {
  const actions = useSyncExternalStore(subscribeActions, fileOpeners, fileOpeners);
  const [selected, setSelected] = useState<FileEditorTarget | null>(null);
  const selectedRef = useRef(selected);
  const ownerRef = useRef(ownerId);
  const leaveRef = useRef(requestLeave);
  const transitioning = useRef(false);
  ownerRef.current = ownerId;
  leaveRef.current = requestLeave;

  const canOpen = useCallback((name: string) => !IS_LITE && Boolean(findFileEditor(name, false, actions)), [actions]);

  /** Resolves the current native account and node at the moment of opening.
   * 열기를 실행하는 시점의 네이티브 계정과 항목을 확인합니다. */
  const open = useCallback((name: string, pluginId?: string) => {
    if (IS_LITE) return false;
    if (selectedRef.current && !transitioning.current) return false;
    const state = useFileStore.getState();
    const resource = state.resources.find((file) => file.name === name);

    if (!resource || resource.isDirectory) return false;
    let candidates = actions;

    if (pluginId) candidates = actions.filter((action) => action.pluginId === pluginId);
    const action = findFileEditor(name, false, candidates);
    const reference = resourceServerRef(resource);
    const accountId = reference.accountId ?? state.client?.getFilesAccountId();

    if (!action || !accountId) return false;
    const next = { instanceId: crypto.randomUUID(), resourceId: resource.id, pluginId: action.pluginId, ownerId, accountId, file: { ...resourceToView(resource, state.currentPath), id: reference.id } };
    selectedRef.current = next;
    setSelected(next);

    return true;
  }, [actions, ownerId]);

  /** Dismisses the selected view; the provider owns any content or metadata reconciliation.
   * 선택 화면만 닫고 내용·메타데이터 재확인은 제공자에게 맡깁니다. */
  const close = useCallback((expected?: FileEditorTarget) => {
    if (expected && selectedRef.current !== expected) return;
    selectedRef.current = null;
    setSelected(current => {
      if (expected && current !== expected) return current;
      return null;
    });
  }, []);

  /** Serialize native navigation and mutations behind the selected provider's leave decision.
   * 선택한 제공자의 이탈 승인을 기다린 뒤 네이티브 탐색·변경을 한 번씩 실행합니다. */
  const runAfterLeave = useCallback(async (action: () => void | Promise<void>) => {
    if (transitioning.current) return false;
    transitioning.current = true;
    const account = ownerRef.current;
    try {
      if (selectedRef.current && (!leaveRef.current || !(await leaveRef.current()))) return false;
      if (account !== ownerRef.current) return false;
      await action();
      return true;
    } finally {
      transitioning.current = false;
    }
  }, []);

  let target = selected;

  if (selected?.ownerId !== ownerId || !actions.some((action) => action.pluginId === selected?.pluginId)) target = null;
  selectedRef.current = target;

  return { target, canOpen, open, close, runAfterLeave };
}
