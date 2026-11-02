import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { OfficeInformation } from '@/lib/eurooffice/client';

const state = vi.hoisted(() => ({
  config: { isLoading: false, error: null as string | null, euroOfficeConfigured: true },
  auth: { activeAccountId: 'account-a', isAuthenticated: true, client: {} },
  office: { accountId: 'account-a', slot: 0 as number | undefined, ready: true, query: { isLoading: false, error: null as Error | null, data: undefined as OfficeInformation | undefined } },
}));
const query = vi.hoisted(() => vi.fn());
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@/i18n/navigation', () => ({ Link: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a> }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => state.config }));
vi.mock('@/hooks/use-eurooffice', () => ({ useEuroOffice: (configured: boolean) => { query(configured); return state.office; } }));
vi.mock('@/stores/auth-store', () => ({ useAuthStore: (select: (value: typeof state.auth) => unknown) => select(state.auth) }));

import { OfficePageContent } from '../office-page-content';

function information(ownerId = 'A'.repeat(43)): OfficeInformation {
  return { ownerId, username: 'a@example.test', enabled: true, workspaceId: 'workspace', connection: { serverUrl: 'https://office.example.test', jwtHeader: 'AuthorizationJwt', hasSecret: true, canManage: false, revision: 1 } };
}

beforeEach(() => {
  state.config = { isLoading: false, error: null, euroOfficeConfigured: true };
  state.auth = { activeAccountId: 'account-a', isAuthenticated: true, client: {} };
  state.office = { accountId: 'account-a', slot: 0, ready: true, query: { isLoading: false, error: null, data: information() } };
  query.mockClear();
});
afterEach(cleanup);

it('opens only the authenticated slot and owner while preserving the Office sandbox', () => {
  render(<OfficePageContent />);
  const frame = screen.getByTitle('EuroOffice');
  expect(frame).toHaveAttribute('src', `${location.origin}/api/eurooffice/view/0/${'A'.repeat(43)}/`);
  expect(frame.getAttribute('sandbox')).not.toContain('allow-downloads');
  expect(frame).toHaveAttribute('inert');
});

it('does not activate a disabled account when its permalink is visited', () => {
  state.office.query.data!.enabled = false;
  render(<OfficePageContent />);
  expect(screen.queryByTitle('EuroOffice')).toBeNull();
  expect(screen.getByRole('link', { name: 'Open Office settings' })).toHaveAttribute('href', '/settings/addons');
});

it('removes the previous account frame while resolving another account', () => {
  const { rerender } = render(<OfficePageContent />);
  const oldFrame = screen.getByTitle('EuroOffice');
  state.auth.activeAccountId = 'account-b';
  state.office.accountId = 'account-b';
  state.office.slot = 2;
  state.office.query.data = undefined;
  state.office.query.isLoading = true;
  rerender(<OfficePageContent />);
  expect(oldFrame).not.toBeInTheDocument();
  state.office.query = { isLoading: false, error: null, data: information('B'.repeat(43)) };
  rerender(<OfficePageContent />);
  expect(screen.getByTitle('EuroOffice')).toHaveAttribute('src', `${location.origin}/api/eurooffice/view/2/${'B'.repeat(43)}/`);
});

it('does not create a frame for an unconfigured host or a failed Native lookup', () => {
  state.config.euroOfficeConfigured = false;
  const { rerender } = render(<OfficePageContent />);
  expect(query).toHaveBeenLastCalledWith(false);
  expect(screen.queryByTitle('EuroOffice')).toBeNull();
  state.config.euroOfficeConfigured = true;
  state.office.query.error = new Error('Native authentication required');
  rerender(<OfficePageContent />);
  expect(screen.getByRole('alert')).toHaveTextContent('Native authentication required');
  expect(screen.queryByTitle('EuroOffice')).toBeNull();
});
