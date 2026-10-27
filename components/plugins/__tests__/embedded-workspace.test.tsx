import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbeddedWorkspace } from '../embedded-workspace';
import { disposeEmbeddedViews, requestEmbeddedView } from '@/lib/plugin-embedded/requests';

const authState = vi.hoisted(() => ({ activeAccountId: 'a' }));
vi.mock('@/stores/auth-store', () => ({ useAuthStore: Object.assign((select: (state: typeof authState) => unknown) => select(authState), { getState: () => authState }) }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
afterEach(() => { act(() => disposeEmbeddedViews()); authState.activeAccountId = 'a'; vi.restoreAllMocks(); });

describe('embedded page composition', () => {
  const policy = { hostOrigin: window.location.origin, frameOrigins: ['https://canvas.test'], framePaths: ['/workspace/'] };
  const open = (scope: Parameters<typeof requestEmbeddedView>[1]) => requestEmbeddedView('example-view', scope, { action: 'open', title: 'Example', url: 'https://canvas.test/workspace/' }, policy) as { id: string };

  it('preserves the page DOM while displaying a sibling frame and after an acknowledged close', async () => {
    render(<EmbeddedWorkspace pluginId="example-view"><div data-testid="page"><input aria-label="Example input" defaultValue="retained value" /></div></EmbeddedWorkspace>);
    const page = screen.getByTestId('page');
    const scope = { slot: 'app-page', signal: new AbortController().signal, container: page };
    let id = '';
    await act(async () => { id = open(scope).id; });
    expect(page).not.toBeVisible();
    expect(page.querySelector('iframe')).toBeNull();
    expect(screen.getByTitle('Example')).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    expect(screen.getByTitle('Example')).not.toHaveAttribute('allow');
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    const event = await requestEmbeddedView('example-view', scope, { action: 'next', id }, policy);
    if (!event || !('type' in event) || event.type !== 'leave') throw new Error('leave event missing');
    await act(async () => { requestEmbeddedView('example-view', scope, { action: 'reply', id, requestId: event.requestId, allow: true }, policy); });
    expect(page).toBeVisible();
    expect(screen.getByLabelText('Example input')).toHaveValue('retained value');
    expect(screen.queryByTitle('Example')).toBeNull();
  });

  it('keeps retrying normal leave separate from the explicitly confirmed host escape', async () => {
    render(<EmbeddedWorkspace pluginId="example-view"><div data-testid="page" /></EmbeddedWorkspace>);
    const scope = { slot: 'app-page', signal: new AbortController().signal, container: screen.getByTestId('page') };
    let id = '';
    await act(async () => { id = open(scope).id; });
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    const event = await requestEmbeddedView('example-view', scope, { action: 'next', id }, policy);
    if (!event || !('type' in event) || event.type !== 'leave') throw new Error('leave event missing');
    await act(async () => { requestEmbeddedView('example-view', scope, { action: 'reply', id, requestId: event.requestId, allow: false }, policy); });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByTitle('Example')).toBeInTheDocument();
    const retry = await requestEmbeddedView('example-view', scope, { action: 'next', id }, policy);
    if (!retry || !('type' in retry) || retry.type !== 'leave') throw new Error('leave retry missing');
    await act(async () => { requestEmbeddedView('example-view', scope, { action: 'reply', id, requestId: retry.requestId, allow: false }, policy); });
    fireEvent.click(screen.getByRole('button', { name: 'close_without_waiting' }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.queryByTitle('Example')).toBeNull();
  });

  it('checks the current account even before React commits an account change', async () => {
    render(<EmbeddedWorkspace pluginId="example-view"><div data-testid="page" /></EmbeddedWorkspace>);
    const scope = { slot: 'app-page', signal: new AbortController().signal, container: screen.getByTestId('page') };
    let id = '';
    await act(async () => { id = open(scope).id; });
    act(() => {
      authState.activeAccountId = 'b';
      expect(() => requestEmbeddedView('example-view', scope, { action: 'next', id }, policy)).toThrow(/account/);
      expect(() => open(scope)).toThrow(/account/);
    });
    expect(screen.queryByTitle('Example')).toBeNull();
  });
});
