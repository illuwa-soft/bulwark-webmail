import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSidebarApps } from '@/hooks/use-sidebar-apps';
import { useSettingsStore, type SidebarApp } from '@/stores/settings-store';
import { APP_FRAME_ORIGINS_COOKIE, parseAppFrameOrigins } from '@/lib/security/app-frame-origins';
import { registerOfficeFrame } from '@/lib/eurooffice/lifecycle';

const navigation = vi.hoisted(() => ({ push: vi.fn(), pathname: '/' }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => navigation, usePathname: () => navigation.pathname }));

function cookieOrigins(): string[] {
  const match = document.cookie.match(new RegExp(`${APP_FRAME_ORIGINS_COOKIE}=([^;]*)`));
  return parseAppFrameOrigins(match?.[1]);
}

function clearCookie(): void {
  document.cookie = `${APP_FRAME_ORIGINS_COOKIE}=; path=/; max-age=0`;
}

function app(overrides: Partial<SidebarApp> = {}): SidebarApp {
  return {
    id: 'app-1',
    name: 'Board',
    url: 'https://board.example.com/x',
    icon: 'Globe',
    openMode: 'inline',
    showOnMobile: false,
    ...overrides,
  };
}

const reload = vi.fn();

beforeEach(() => {
  clearCookie();
  sessionStorage.clear();
  reload.mockClear();
  navigation.push.mockClear();
  navigation.pathname = '/';
  useSettingsStore.setState({ sidebarApps: [], keepAppsLoaded: false });
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, protocol: 'http:', reload },
  });
});

describe('useSidebarApps CSP cookie', () => {
  it('opens Office at its stable page without retaining a second inline frame', async () => {
    const { result } = renderHook(() => useSidebarApps());
    await act(async () => {
      await result.current.handleInlineApp('office', `${location.origin}/api/eurooffice/view/2/${'A'.repeat(43)}/`, 'EuroOffice');
    });
    expect(navigation.push).toHaveBeenCalledWith('/apps/euro-office');
    expect(result.current.inlineApp).toBeNull();
    expect(result.current.loadedApps).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps the Office page when its exact frame refuses final close', async () => {
    navigation.pathname = '/apps/euro-office';
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const peer = iframe.contentWindow!;
    const send = vi.spyOn(peer, 'postMessage').mockImplementation(() => {});
    const unregister = registerOfficeFrame(peer);
    try {
      window.dispatchEvent(new MessageEvent('message', { source: peer, origin: location.origin, data: { source: 'office-app', event: 'ready' } }));
      const { result } = renderHook(() => useSidebarApps());
      let closing: Promise<void>;
      act(() => { closing = result.current.closeInlineApp(); });
      const request = send.mock.calls[0][0] as { requestId: string };
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', { source: peer, origin: location.origin, data: { source: 'office-app', event: 'leave-result', requestId: request.requestId, canLeave: false } }));
        await closing!;
      });
      expect(navigation.push).not.toHaveBeenCalled();
    } finally { unregister(); iframe.remove(); send.mockRestore(); }
  });

  it('reveals the Office page when returning from another inline app on the same route', async () => {
    navigation.pathname = '/apps/euro-office';
    const { result } = renderHook(() => useSidebarApps());
    await act(async () => { await result.current.handleInlineApp('board', `${location.origin}/board`, 'Board'); });
    expect(result.current.inlineApp?.id).toBe('board');
    await act(async () => { await result.current.handleInlineApp('office', `${location.origin}/api/eurooffice/view/0/${'A'.repeat(43)}/`, 'EuroOffice'); });
    expect(result.current.inlineApp).toBeNull();
    expect(navigation.push).toHaveBeenLastCalledWith('/apps/euro-office');
  });

  it('returns to mail after the dedicated Office page confirms final close', async () => {
    navigation.pathname = '/apps/euro-office';
    const { result } = renderHook(() => useSidebarApps());
    await act(async () => { await result.current.closeInlineApp(); });
    expect(navigation.push).toHaveBeenCalledWith('/');
  });

  it('publishes the origins of inline apps so the proxy can widen frame-src', () => {
    useSettingsStore.setState({
      sidebarApps: [
        app(),
        app({ id: 'app-2', url: 'https://news.example.com', openMode: 'tab' }),
      ],
    });

    renderHook(() => useSidebarApps());

    expect(cookieOrigins()).toEqual(['https://board.example.com']);
  });

  it('reloads once so a newly added app opens under a CSP that allows it', () => {
    useSettingsStore.setState({ sidebarApps: [app()] });
    const { result } = renderHook(() => useSidebarApps());

    act(() => {
      result.current.handleInlineApp('app-1', 'https://board.example.com/x', 'Board');
    });

    // Cookie was empty when the document loaded, so the iframe would be blocked.
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.inlineApp).toBeNull();
    expect(sessionStorage.getItem('bulwark:pending-inline-app')).toContain('app-1');
  });

  it('reopens the pending app after that reload without reloading again', () => {
    useSettingsStore.setState({ sidebarApps: [app()] });
    const { result: first } = renderHook(() => useSidebarApps());
    act(() => {
      first.current.handleInlineApp('app-1', 'https://board.example.com/x', 'Board');
    });
    reload.mockClear();

    // Second document: the cookie set above now backs the CSP.
    const { result } = renderHook(() => useSidebarApps());

    expect(result.current.inlineApp?.id).toBe('app-1');
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('bulwark:pending-inline-app')).toBeNull();
  });

  it('opens without a reload when the origin is already in the CSP', () => {
    document.cookie = `${APP_FRAME_ORIGINS_COOKIE}=${encodeURIComponent('https://board.example.com')}; path=/`;
    useSettingsStore.setState({ sidebarApps: [app()] });

    const { result } = renderHook(() => useSidebarApps());
    act(() => {
      result.current.handleInlineApp('app-1', 'https://board.example.com/x', 'Board');
    });

    expect(reload).not.toHaveBeenCalled();
    expect(result.current.inlineApp?.id).toBe('app-1');
  });

  it('opens without a reload when the URL has no usable origin', () => {
    const { result } = renderHook(() => useSidebarApps());
    act(() => {
      result.current.handleInlineApp('app-1', 'not a url', 'Broken');
    });

    expect(reload).not.toHaveBeenCalled();
    expect(result.current.inlineApp?.id).toBe('app-1');
  });
});
