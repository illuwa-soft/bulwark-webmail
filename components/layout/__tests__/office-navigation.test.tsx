import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key, useLocale: () => 'en' }));
vi.mock('@/i18n/navigation', () => ({ usePathname: () => '/', useRouter: () => navigation, Link: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a> }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({}) }));
vi.mock('@/hooks/use-stalwart-admin', () => ({ useStalwartAdmin: () => false }));
vi.mock('@/hooks/use-resolved-sidebar-apps', () => ({ useResolvedSidebarApps: () => [] }));
vi.mock('@/hooks/use-plugin-pages', () => ({ usePluginPages: () => [{ pluginId: 'fixture', id: 'page', title: 'Plugin page' }], pluginPageHref: () => '/plugin/fixture/page', isPluginPageActive: () => false }));
vi.mock('@/components/notifications/notification-center', () => ({ NotificationBell: () => null }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/layout/account-switcher', () => ({ AccountSwitcher: () => null }));
vi.mock('@/components/keyboard-shortcuts-modal', () => ({ KeyboardShortcutsModal: () => null }));
vi.mock('@/stores/update-store', () => ({ useUpdateStore: (select: (value: object) => unknown) => select({ startPolling: () => {} }), selectHasUpdate: () => false }));

import { NavigationRail } from '../navigation-rail';
import { registerOfficeFrame } from '@/lib/eurooffice/lifecycle';

afterEach(() => { cleanup(); vi.restoreAllMocks(); navigation.push.mockReset(); });

it('waits for final close on plugin-page navigation and preserves the document when close is refused', async () => {
  const iframe = document.createElement('iframe');
  document.body.append(iframe);
  const peer = iframe.contentWindow!;
  const send = vi.spyOn(peer, 'postMessage').mockImplementation(() => {});
  const unregister = registerOfficeFrame(peer);
  try {
    window.dispatchEvent(new MessageEvent('message', { source: peer, origin: location.origin, data: { source: 'office-app', event: 'ready' } }));
    const close = vi.fn();
    render(<NavigationRail activeAppId="eurooffice-fixture" onCloseInlineApp={close} />);
    fireEvent.click(screen.getByRole('link', { name: 'Plugin page' }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(close).not.toHaveBeenCalled();
    const request = send.mock.calls[0][0] as { requestId: string };
    act(() => window.dispatchEvent(new MessageEvent('message', { source: peer, origin: location.origin, data: { source: 'office-app', event: 'leave-result', requestId: request.requestId, canLeave: false } })));
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    expect(navigation.push).not.toHaveBeenCalled();
  } finally { unregister(); iframe.remove(); }
});
