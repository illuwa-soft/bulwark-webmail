// Open composers that plugins may work on (api.composer.*).
//
// Each composer registers a handle under a random id while it is open. A
// plugin learns the id only from the composer itself: the click context of
// a composer action (Attach menu, toolbar, Options, Send menu) or the props
// of a composer slot. So a plugin edits the message the user pointed it
// at, never one it found by itself.

import { generateUUID } from '@/lib/utils';
import type { ComposerSnapshot, ComposerAttachmentData } from '@/lib/plugin-types';

export interface ComposerContent {
  html: string;
  text: string;
}

export interface ComposerAttachment {
  blobId: string;
  name: string;
  type: string;
  size: number;
}

export interface ComposerHandle {
  /** Review metadata of this composer only. 이 작성창의 검수 메타데이터만 제공합니다. */
  readMetadata?(): { subject: string; to: string[]; attachments: { id: string; name: string; type: string; size: number }[]; accountKey?: string; identityId?: string; cc?: string[]; bcc?: string[]; pending?: boolean };
  /** Read only a currently attached file. 현재 첨부된 파일만 읽습니다. */
  readAttachment?(id: string): Promise<ComposerAttachmentData>;
  /** The user's own text, without the signature and the quote. */
  readBody(): ComposerContent;
  readSelection(): ComposerContent & { empty: boolean };
  /** Replace the user's own text. */
  replaceBody(html: string, text: string): boolean;
  /** Replace the selection (or insert at the caret), or with `below` add after it. */
  replaceSelection(html: string, text: string, opts: { below: boolean }): boolean;
  /** Attach a blob the plugin uploaded, through the composer's usual checks. */
  attach(file: ComposerAttachment): Promise<boolean>;
}

const handles = new Map<string, ComposerHandle>();
const snapshots = new Map<string, { fingerprint: string; revision: string }>();

/** Capture a token bound to body, recipients, attachments and account.
 * 본문·수신인·첨부·계정에 결합한 검수 토큰을 생성합니다. */
export function captureComposer(id: string): ComposerSnapshot {
  const handle = handles.get(id);
  if (!handle) throw new Error('composer is not open any more');
  const body = handle.readBody();
  const metadata = handle.readMetadata?.() ?? { subject: '', to: [], attachments: [] };
  const fingerprint = JSON.stringify({ body, metadata });
  let current = snapshots.get(id);
  if (current?.fingerprint !== fingerprint) {
    current = { fingerprint, revision: generateUUID() };
    snapshots.set(id, current);
  }
  return { revision: current!.revision, subject: metadata.subject, to: metadata.to, attachments: metadata.attachments, text: body.text, pending: metadata.pending ?? false };
}

/** Register an open composer. Returns its id and a function that unregisters it. */
export function registerComposer(handle: ComposerHandle): { id: string; unregister: () => void } {
  const id = generateUUID();
  handles.set(id, handle);
  return { id, unregister: () => { handles.delete(id); snapshots.delete(id); } };
}

export function composerHandle(id: unknown): ComposerHandle | null {
  return typeof id === 'string' ? handles.get(id) ?? null : null;
}

/** Test helper. */
export function resetComposers(): void {
  handles.clear();
  snapshots.clear();
}
