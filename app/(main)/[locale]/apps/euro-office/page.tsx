import { PluginPageApp } from '@/components/plugins/plugin-page-app';
import { OfficePageContent } from '@/components/eurooffice/office-page-content';

/** Reuse the signed-in app shell without registering Office as a global plugin page.
 * Office를 전역 플러그인 페이지로 등록하지 않고 로그인한 앱 화면 틀을 재사용합니다. */
export default function OfficePageRoute() {
  return <PluginPageApp pageTitle="EuroOffice"><OfficePageContent /></PluginPageApp>;
}
