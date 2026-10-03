import { MarkdownView, Notice } from 'obsidian';
import type DriveImagesPlugin from './main';
import { DriveClient, UnauthorizedError } from '../drive/client';
import { findDriveLinks } from '../editor/driveEmbeds';
import { driveDeletionWatcher } from '../editor/deletionWatcher';
import { OrphanReconciler } from './orphanReconciler';

// Removing an image from every note puts its Drive file on a pending-deletion
// list; undoing the removal takes it off. Drive is only touched when the user
// runs "Delete from Drive". See orphanReconciler.ts for the list-convergence logic.
const LIST_GRACE_MS = 2_000;
const DELIST_DELAY_MS = 400;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function registerDriveTrashSync(plugin: DriveImagesPlugin): void {
  const reconciler = new OrphanReconciler({
    isOwned: (id) => plugin.isUploadedFileId(id),
    isPending: (id) => id in plugin.settings.pendingDeletes,
    findReferenced: (ids) => findReferencedIds(plugin, ids),
    addPending: async (id) => {
      plugin.settings.pendingDeletes[id] = { addedAt: Date.now() };
      await plugin.saveSettings();
      plugin.onPendingChanged?.();
    },
    removePending: async (id) => {
      delete plugin.settings.pendingDeletes[id];
      await plugin.saveSettings();
      plugin.onPendingChanged?.();
    },
    onError: (action, id, err) => console.error(`[Drive Images] pending ${action} ${id} failed`, err),
    graceMs: LIST_GRACE_MS,
    restoreMs: DELIST_DELAY_MS,
  });
  plugin.register(() => reconciler.dispose());

  plugin.registerEditorExtension(
    driveDeletionWatcher((removed, added) => {
      const { settings } = plugin;
      if (!settings.trackRemovedImages) return;
      reconciler.touched(removed, added);
    }),
  );
}

/**
 * Which of `ids` are referenced by any markdown note. Open notes are read from
 * their live editor (disk can lag unsaved edits by seconds); the rest from the
 * vault. A cheap substring test gates the link regex.
 */
async function findReferencedIds(plugin: DriveImagesPlugin, ids: Set<string>): Promise<Set<string>> {
  const { workspace, vault } = plugin.app;
  const found = new Set<string>();

  const scan = (text: string) => {
    let any = false;
    for (const id of ids) {
      if (!found.has(id) && text.includes(id)) any = true;
    }
    if (!any) return;
    for (const l of findDriveLinks(text)) if (ids.has(l.fileId)) found.add(l.fileId);
  };

  const open = new Set<string>();
  workspace.iterateAllLeaves((leaf) => {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file) {
      open.add(view.file.path);
      scan(view.editor.getValue());
    }
  });

  for (const file of vault.getMarkdownFiles()) {
    if (found.size === ids.size) break;
    if (open.has(file.path)) continue;
    scan(await vault.cachedRead(file));
  }
  return found;
}

async function withRefresh<T>(plugin: DriveImagesPlugin, run: (c: DriveClient) => Promise<T>): Promise<T> {
  const client = new DriveClient(plugin.getRequest(), () => plugin.getAccessToken());
  try {
    return await run(client);
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) throw e;
    await plugin.refreshAccessToken();
    return run(client);
  }
}

/**
 * Delete every file on the pending list from Drive (moved to the Drive trash,
 * recoverable for 30 days). References are re-checked first, so an image that
 * was re-embedded since it was listed (e.g. pasted again) is kept and delisted.
 * Failures stay on the list for a retry.
 */
export async function deletePendingFromDrive(
  plugin: DriveImagesPlugin,
): Promise<{ deleted: number; kept: number; failed: number }> {
  const { settings } = plugin;
  const result = { deleted: 0, kept: 0, failed: 0 };
  const ids = new Set(Object.keys(settings.pendingDeletes));
  if (ids.size === 0) {
    new Notice('Drive Images: nothing to delete.');
    return result;
  }
  if (!settings.tokens) {
    new Notice('Drive Images: sign in to Google Drive first.');
    return result;
  }

  let referenced: Set<string>;
  try {
    referenced = await findReferencedIds(plugin, ids);
  } catch (e) {
    new Notice(`Drive Images: could not scan notes (${errorMessage(e)}); nothing deleted.`);
    return result;
  }

  for (const id of ids) {
    if (referenced.has(id) || !plugin.isUploadedFileId(id)) {
      delete settings.pendingDeletes[id];
      result.kept += 1;
      continue;
    }
    try {
      await withRefresh(plugin, (c) => c.setTrashed(id, true)); // 'missing' = already gone: fine
      // Forget the dedup entry so pasting the same bytes again uploads afresh.
      for (const h of Object.keys(settings.uploadCache)) {
        if (settings.uploadCache[h] === id) delete settings.uploadCache[h];
      }
      delete settings.pendingDeletes[id];
      result.deleted += 1;
    } catch (e) {
      console.error(`[Drive Images] delete ${id} failed`, e);
      result.failed += 1;
    }
  }
  await plugin.saveSettings();
  plugin.onPendingChanged?.();

  new Notice(
    `Drive Images: deleted ${result.deleted} from Drive` +
      (result.kept ? ` · kept ${result.kept} still in use` : '') +
      (result.failed ? ` · ${result.failed} failed (still pending)` : ''),
  );
  return result;
}
