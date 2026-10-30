import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FilesSidebar } from '@/components/files/files-sidebar';
import type { FileResource } from '@/stores/file-store';

const folder: FileResource = {
  id: 'documents', name: 'Documents', serverName: 'Documents', isDirectory: true,
  contentType: '', contentLength: 0, lastModified: '2026-10-01T00:00:00Z',
  blobId: null, parentId: null,
};
const document: FileResource = {
  ...folder, id: 'document', name: 'hello.docx', serverName: 'hello.docx',
  isDirectory: false, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  contentLength: 1400, blobId: 'synthetic-document',
};
const navigate = vi.fn();
const noop = vi.fn();
const props = {
  currentParentId: null, currentPath: '/', allFolders: [folder],
  // Upgrade input from the removed explorer must not create file tree rows.
  // 제거된 탐색기의 이전 입력으로 파일 트리 행을 다시 만들면 안 됩니다.
  allFiles: [document], sharedRoots: [], favorites: [], recentFiles: [], canCreate: true,
  onNavigate: navigate, onOpenRecent: noop, onUploadFiles: noop, onUploadFolder: noop,
  onNewFolder: noop, onNewTextFile: noop, onToggleFavorite: noop, onDropItems: noop,
  canShare: () => false, onShare: noop, onCreateIn: noop, onRenameFolder: noop,
  onDeleteFolder: noop, onRevealRecent: noop, onDownloadRecent: noop, onRemoveRecent: noop,
  onToggleExplorer: noop, onOpenFile: noop,
};

beforeEach(() => {
  localStorage.clear();
  navigate.mockClear();
});
afterEach(cleanup);

it('keeps the native folder explorer visible despite the retired collapse preference', () => {
  localStorage.setItem('files-explorer-collapsed', 'true');
  render(<FilesSidebar {...props} />);
  expect(screen.getByRole('tree', { name: 'my_files' })).toBeVisible();
  expect(screen.queryByRole('button', { name: /explorer/i })).toBeNull();
});

it('lists folders in My files without duplicating regular files in the tree', () => {
  render(<FilesSidebar {...props} />);
  const tree = within(screen.getByRole('tree', { name: 'my_files' }));
  expect(tree.getByText('Documents')).toBeVisible();
  expect(tree.queryByText('hello.docx')).toBeNull();
});

it('still opens folders through the native navigation callback', () => {
  render(<FilesSidebar {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
  expect(navigate).toHaveBeenCalledWith('/Documents', 'documents');
});
