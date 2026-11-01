import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InlineAppView } from '@/components/layout/inline-app-view';

const apps = [
  { id: 'office', name: 'EuroOffice', url: 'https://office.example.test/' },
  { id: 'wiki', name: 'Wiki', url: 'https://wiki.example.test/' },
];

describe('inline app native chrome', () => {
  it('accepts the unmodified official Files caller without adding chrome or invoking navigation', () => {
    const onClose = vi.fn();
    render(<InlineAppView apps={apps} activeAppId="office" onClose={onClose} />);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('gives the embedded app the full content surface without a duplicate title/close row', () => {
    const { container } = render(<InlineAppView apps={apps} activeAppId="office" />);
    expect(screen.queryByRole('heading', { name: 'EuroOffice' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(container.querySelector('iframe[title="EuroOffice"]')?.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'
    );
  });

  it('preserves each loaded frame while switching the visible app', () => {
    const { container, rerender } = render(<InlineAppView apps={apps} activeAppId="office" />);
    const office = container.querySelector('iframe[title="EuroOffice"]');
    const wiki = container.querySelector('iframe[title="Wiki"]');
    expect(office?.className).not.toContain('hidden');
    expect(wiki?.className).toContain('hidden');
    rerender(<InlineAppView apps={apps} activeAppId="wiki" />);
    expect(container.querySelector('iframe[title="EuroOffice"]')).toBe(office);
    expect(container.querySelector('iframe[title="Wiki"]')).toBe(wiki);
    expect(office?.className).toContain('hidden');
    expect(wiki?.className).not.toContain('hidden');
  });
});
