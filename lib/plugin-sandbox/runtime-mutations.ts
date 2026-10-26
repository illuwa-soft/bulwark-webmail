import type { ContactCard } from '../jmap/types';
import type { CalendarEventInput, CalendarEventView, DraftInput, EmailReadView, FileResourceView, MailboxView, PluginDirectoryInput, PluginFilePatch, PluginSendInput, PluginSendResult, PluginTextFileInput } from '../plugin-types';

type Rpc = (method: string, args: unknown[], timeoutMs?: number) => Promise<unknown>;

/** Each call carries the original account stamp, checked inside the host immediately before dispatch. */
function scopedApi(scope: string, rpc: Rpc) {
  const call = (command: string, args: unknown[]) => rpc('mutations.apply', [scope, command, args], 0);
  return {
    email: {
      get: (id: string) => call('mail-get', [id]) as Promise<EmailReadView | null>,
      move: (ids: string[], mailboxId: string) => call('mail-move', [ids, mailboxId]) as Promise<void>,
      update: (ids: string[], changes: { isRead?: boolean; isFlagged?: boolean }) => call('mail-update', [ids, changes]) as Promise<void>,
      trash: (ids: string[]) => call('mail-trash', [ids]) as Promise<void>,
      send: (message: PluginSendInput) => call('mail-send', [message]) as Promise<PluginSendResult>,
    },
    drafts: { create: (draft: DraftInput) => call('mail-draft', [draft]) as Promise<string> },
    mailboxes: { list: () => call('mailboxes-list', [{ scope: 'primary' }]) as Promise<MailboxView[]> },
    addressBooks: { list: () => call('addressbooks-list', []) },
    contacts: {
      get: (id: string) => call('contact-get', [id]) as Promise<ContactCard | null>,
      create: (card: ContactCard) => call('contact-create', [card]) as Promise<ContactCard>,
      update: (id: string, patch: Partial<ContactCard>) => call('contact-update', [id, patch]) as Promise<void>,
      remove: (id: string) => call('contact-remove', [id]) as Promise<void>,
    },
    calendar: {
      getEvent: (id: string) => call('calendar-get', [id, { scope: 'primary' }]) as Promise<CalendarEventView | null>,
      listCalendars: () => call('calendars-list', [{ scope: 'primary' }]),
      createEvent: (event: CalendarEventInput) => call('calendar-create', [event]) as Promise<CalendarEventView | null>,
      updateEvent: (id: string, patch: Partial<CalendarEventInput>) => call('calendar-update', [id, patch]) as Promise<void>,
      deleteEvent: (id: string) => call('calendar-remove', [id]) as Promise<void>,
    },
    files: {
      get: (id: string) => call('file-get', [id]) as Promise<FileResourceView>,
      createText: (input: PluginTextFileInput) => call('file-create-text', [input]) as Promise<FileResourceView>,
      createDirectory: (input: PluginDirectoryInput) => call('file-create-directory', [input]) as Promise<FileResourceView>,
      update: (id: string, patch: PluginFilePatch) => call('file-update', [id, patch]) as Promise<FileResourceView>,
      remove: (id: string) => call('file-remove', [id]) as Promise<{ id: string; deleted: true }>,
    },
  };
}

export function createMutationApi(rpc: Rpc) {
  return { scope: () => rpc('mutations.scope', []) as Promise<string>, forScope: (scope: string) => scopedApi(scope, rpc) };
}
