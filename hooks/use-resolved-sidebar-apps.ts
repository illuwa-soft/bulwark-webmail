'use client';

import { useMemo } from 'react';
import { useSettingsStore } from '@/stores/settings-store';
import { usePolicyStore } from '@/stores/policy-store';
import { mergeSidebarApps, sanitizeDefaultSidebarApps, type ResolvedSidebarApp } from '@/lib/sidebar-apps';
import type { AdminSidebarApp } from '@/lib/admin/types';
import { useEuroOffice } from '@/hooks/use-eurooffice';
import { officeViewUrl } from '@/lib/eurooffice/client';

/** The apps the operator pins for every user (#931), validated. */
export function useManagedSidebarApps(): AdminSidebarApp[] {
  const defaults = usePolicyStore((s) => s.policy.defaultSidebarApps);
  return useMemo(() => sanitizeDefaultSidebarApps(defaults), [defaults]);
}

/**
 * The full sidebar app list: operator-provided apps first, then the user's own.
 *
 * `sidebarAppsEnabled` gates only the user's custom apps, so turning it off
 * still leaves the operator's set in place.
 */
export function useResolvedSidebarApps(euroOfficeConfigured = false): ResolvedSidebarApp[] {
  const userApps = useSettingsStore((s) => s.sidebarApps);
  const defaults = usePolicyStore((s) => s.policy.defaultSidebarApps);
  const userAppsEnabled = usePolicyStore((s) => s.isFeatureEnabled('sidebarAppsEnabled'));
  const office = useEuroOffice(euroOfficeConfigured);
  return useMemo(
    () => {
      const apps = mergeSidebarApps(defaults, userAppsEnabled ? userApps : []).filter((app) => app.id !== 'admin-app-eurooffice-workspace');
      if (office.ready && office.query.data?.enabled && office.slot !== undefined)
        apps.push({ id: `eurooffice-${office.query.data.ownerId}`, name: 'EuroOffice', url: officeViewUrl(office.slot, office.query.data.ownerId), icon: 'FileText', openMode: 'inline', showOnMobile: true, managed: true });
      return apps;
    },
    [defaults, userApps, userAppsEnabled, office.query.data, office.slot, office.ready]
  );
}
