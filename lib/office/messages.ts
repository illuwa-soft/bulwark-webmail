const en = {
  title: 'Office', back: 'Document library', save: 'Save to Stalwart',
  loading: 'Opening the document in EuroOffice…', ready: 'Editor ready',
  dirty: 'Changes have not been saved to Stalwart', saved: 'Saved to the Stalwart original',
  saving: 'Confirming the Stalwart save…', closing: 'Confirming the final save and editor close…',
  confirm: 'Save and confirm the Stalwart original before leaving? Cancel to continue editing.',
  openError: 'The document could not be opened. Check the connection and approved editor origin.',
  editorError: 'EuroOffice could not open the document. Return to the library and check the connection.',
  saveError: 'The Stalwart save could not be confirmed. The editor is retained; no overwrite or automatic write retry was attempted.',
  closeError: 'The final editor close could not be confirmed. Check again before leaving.',
  recheck: 'Check save status', abandon: 'Close without save confirmation',
  abandonConfirm: 'Close without confirming the original save? Server-side saving may still finish. This does not undo changes.',
};
const ko: typeof en = {
  title: 'Office', back: '문서함으로', save: 'Stalwart에 저장',
  loading: 'EuroOffice에서 문서를 여는 중입니다…', ready: '편집기 준비 완료',
  dirty: 'Stalwart에 저장되지 않은 변경이 있습니다', saved: 'Stalwart 원본 저장 확인됨',
  saving: 'Stalwart 원본 저장을 확인하고 있습니다…', closing: '편집기의 최종 저장·종료를 확인하고 있습니다…',
  confirm: 'Stalwart 원본 저장을 확인한 뒤 이동하시겠습니까? 취소하면 편집을 계속합니다.',
  openError: '문서를 열지 못했습니다. 접속설정과 편집 서버 허용 출처를 확인해 주세요.',
  editorError: 'EuroOffice가 문서를 열지 못했습니다. 문서함으로 돌아가 연결을 확인해 주세요.',
  saveError: 'Stalwart 원본 저장을 확인하지 못했습니다. 덮어쓰기나 자동 재시도 없이 편집 화면을 유지합니다.',
  closeError: '편집 세션 종료를 확인하지 못했습니다. 다시 확인해 주세요.',
  recheck: '저장 상태 다시 확인', abandon: '저장 미확인 상태로 종료',
  abandonConfirm: '원본 저장을 확인하지 않고 편집을 종료하시겠습니까? 서버 저장은 계속될 수 있으며 변경 사항을 되돌리는 동작은 아닙니다.',
};
export function officeMessages(locale = 'en') { if (locale.startsWith('ko')) return ko; return en; }
