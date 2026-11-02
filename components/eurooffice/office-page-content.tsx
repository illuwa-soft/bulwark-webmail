'use client';

import { useLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useConfig } from '@/hooks/use-config';
import { useEuroOffice } from '@/hooks/use-eurooffice';
import { InlineAppFrame } from '@/components/layout/inline-app-frame';
import { officeViewUrl } from '@/lib/eurooffice/client';
import { IS_LITE } from '@/lib/lite';

const english = {
  loading: 'Checking the current Office account…',
  setup: 'The operator must configure the webmail Office connector.',
  enable: 'Enable EuroOffice for this account in Settings → Add-ons.',
  settings: 'Open Office settings',
  unavailable: 'EuroOffice account connections require the full webmail server.',
};
const korean: typeof english = {
  loading: '현재 Office 계정을 확인하고 있습니다…',
  setup: '운영자가 웹메일의 Office 연결을 설정해야 합니다.',
  enable: '설정 → 추가 기능에서 이 계정의 EuroOffice를 활성화해 주세요.',
  settings: 'Office 설정 열기',
  unavailable: 'EuroOffice 계정 연결은 전체 웹메일 서버에서 지원합니다.',
};

/** Resolve the Native account on every visit; the permalink never grants or enables access.
 * 방문할 때 Native 계정을 확인하며 고정 주소로 권한을 부여하거나 자동 활성화하지 않습니다. */
export function OfficePageContent() {
  const locale = useLocale();
  const config = useConfig();
  const office = useEuroOffice(config.euroOfficeConfigured === true);
  let copy = english;
  if (locale.startsWith('ko')) copy = korean;
  if (IS_LITE) return <p role="status" className="p-4 text-sm">{copy.unavailable}</p>;
  if (config.isLoading) return <p role="status" className="p-4 text-sm">{copy.loading}</p>;
  if (config.error) return <p role="alert" className="p-4 text-sm">{config.error}</p>;
  if (!config.euroOfficeConfigured) return <p role="status" className="p-4 text-sm">{copy.setup}</p>;
  if (!office.ready || office.query.isLoading) return <p role="status" className="p-4 text-sm">{copy.loading}</p>;
  if (office.query.error) return <p role="alert" className="p-4 text-sm">{office.query.error.message}</p>;
  if (!office.query.data?.enabled || office.slot === undefined) return <div className="space-y-3 p-4 text-sm">
    <p>{copy.enable}</p>
    <Link href="/settings/addons" className="text-primary underline underline-offset-2">{copy.settings}</Link>
  </div>;
  const account = office.query.data;
  const app = { id: `eurooffice-${account.ownerId}`, name: 'EuroOffice', url: officeViewUrl(office.slot, account.ownerId) };
  return <div data-eurooffice-page className="relative flex-1 min-h-0">
    <InlineAppFrame key={`${office.accountId}:${office.slot}:${account.ownerId}`} app={app} active />
  </div>;
}
