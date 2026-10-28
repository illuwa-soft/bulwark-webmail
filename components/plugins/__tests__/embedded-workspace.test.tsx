import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EmbeddedWorkspace } from '../embedded-workspace';
import { requestEmbeddedView } from '@/lib/plugin-embedded/requests';

vi.mock('@/stores/auth-store', () => ({ useAuthStore: (select: (state: { activeAccountId: string }) => unknown) => select({ activeAccountId: 'a' }) }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

describe('embedded workspace composition', () => {
  it('keeps the opaque page mounted and restores it after the plugin acknowledges leave', async () => {
    render(<EmbeddedWorkspace pluginId="drawing"><div data-testid="plugin"><input aria-label="Search" defaultValue="saved search" /></div></EmbeddedWorkspace>);
    const page = screen.getByTestId('plugin');
    const scope = { slot: 'app-page', signal: new AbortController().signal, container: page };
    const policy = { hostOrigin: window.location.origin, frameOrigins: ['https://canvas.test'], framePaths: ['/drawing/'] };
    let opened: { id: string };
    await act(async () => { opened = requestEmbeddedView('drawing', scope, { action: 'open', url: 'https://canvas.test/drawing/a', title: 'Drawing' }, policy) as { id: string }; });
    const frame = screen.getByTitle('Drawing');
    expect(page).toBeInTheDocument();
    expect(page).not.toBeVisible();
    expect(page.querySelector('iframe')).toBeNull();
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    const event = await requestEmbeddedView('drawing', scope, { action: 'next', id: opened!.id }, policy);
    if (!event || !('type' in event) || event.type !== 'leave') throw new Error('Leave request missing');
    await act(async () => { requestEmbeddedView('drawing', scope, { action: 'reply', id: opened.id, requestId: event.requestId, allow: true }, policy); });
    expect(page).toBeVisible();
    expect(screen.getByLabelText('Search')).toHaveValue('saved search');
    expect(screen.queryByTitle('Drawing')).toBeNull();
  });
});
