import type { EmbedFormat, TokenSet } from '../drive/types';

// Persisted plugin settings. Load/save happens in main.ts via plugin
// loadData/saveData, merging over DEFAULT_SETTINGS.
export interface Settings {
  clientId: string;
  clientSecret: string;
  /** The plugin-owned Drive folder PATH (e.g. `A/B/C`) images upload into. */
  folderName: string;
  /** Optional existing Drive folder id the path is created inside. Empty = root. */
  parentFolderId: string;
  /** Internal cache: the resolved id of the final folder in `folderName`. */
  folderId: string;
  /** Internal cache key (`parentFolderId|folderName`) guarding the folderId cache. */
  folderCacheKey: string;
  embedFormat: EmbedFormat;
  makePublic: boolean;
  /** After a successful bulk conversion, move the original attachment to trash. */
  deleteLocalAfterConvert: boolean;
  /** Track images removed from notes on a pending-deletion list (undo delists them). */
  trackRemovedImages: boolean;
  tokens: TokenSet | null;
  /** Content sha256 (hex) → Drive fileId, to skip re-uploading identical bytes. */
  uploadCache: Record<string, string>;
  /** Uploaded files whose image was removed from every note, awaiting "Delete from Drive". */
  pendingDeletes: Record<string, { addedAt: number }>;
}

export const DEFAULT_SETTINGS: Settings = {
  clientId: '',
  clientSecret: '',
  folderName: 'Obsidian Images',
  parentFolderId: '',
  folderId: '',
  folderCacheKey: '',
  embedFormat: 'lh3',
  makePublic: true,
  deleteLocalAfterConvert: false,
  trackRemovedImages: true,
  tokens: null,
  uploadCache: {},
  pendingDeletes: {},
};
