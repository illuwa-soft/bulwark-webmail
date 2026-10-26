import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OfficeWorkspace } from '../office-workspace';
import { requestOfficeEditor } from '@/lib/office/requests';

vi.mock('@/stores/auth-store', () => ({ useAuthStore: (select: (state: { activeAccountId: string }) => unknown) => select({ activeAccountId: 'account-a' }) }));
vi.mock('next-intl', () => ({ useLocale: () => 'ko' }));

describe('Office workspace composition', () => {
  it('keeps the library mounted and preserves its input while the host sibling owns the editor', async () => {
    render(<OfficeWorkspace pluginId="office"><div data-testid="library"><input aria-label="Library search" defaultValue="saved search" /></div></OfficeWorkspace>);
    const library = screen.getByTestId('library');
    let ended = false;
    let opened!: Promise<unknown>;
    const receipt = { sessionId: 'session-a', state: 'editing', savedAt: null, saveRequestId: null };
    await act(async () => {
      opened = requestOfficeEditor({ pluginId: 'office', fileId: 'a', hostOrigin: window.location.origin, allowedOrigins: ['https://editor.test'], request: async command => {
        if (command.action === 'session.end') { ended = true; return {}; }
        if (command.action === 'session.status') return { ...receipt, state: ended ? 'closed' : 'editing' };
        return { ...receipt, fileName: 'Sales.xlsx', editorUrl: `https://editor.test/api/v1/eurooffice/embed/session-a#${'a'.repeat(43)}` };
      } });
    });
    const frame = screen.getByTitle('EuroOffice 문서 편집기');
    expect(library).toBeInTheDocument();
    expect(library).not.toBeVisible();
    expect(library.querySelector('iframe')).toBeNull();
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    fireEvent.click(screen.getByRole('button', { name: '문서함으로' }));
    await waitFor(() => expect(library).toBeVisible());
    expect(screen.getByLabelText('Library search')).toHaveValue('saved search');
    expect(screen.queryByTitle('EuroOffice 문서 편집기')).toBeNull();
    expect(await opened).toMatchObject({ state: 'closed' });
  });
});
