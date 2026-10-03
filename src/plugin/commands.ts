import { MarkdownView } from 'obsidian';
import type DriveImagesPlugin from './main';
import { convertLocalImages } from './batchConvert';
import { reResolveLinks, reResolveVault } from './reResolve';
import { deletePendingFromDrive } from './driveTrash';

/** Register the Google Drive sign-in / sign-out and bulk-convert commands. */
export function registerCommands(plugin: DriveImagesPlugin): void {
  plugin.addCommand({
    id: 'drive-sign-in',
    name: 'Sign in to Google Drive',
    callback: () => {
      void plugin.signIn();
    },
  });

  plugin.addCommand({
    id: 'drive-sign-out',
    name: 'Sign out of Google Drive',
    callback: () => {
      void plugin.signOut();
    },
  });

  plugin.addCommand({
    id: 'convert-local-images',
    name: 'Convert local images to Drive links',
    editorCallback: (editor, view) => {
      if (view instanceof MarkdownView) {
        void convertLocalImages(plugin, editor, view);
      }
    },
  });

  plugin.addCommand({
    id: 'reresolve-drive-links',
    name: 'Re-resolve Drive image links',
    editorCallback: (editor, view) => {
      if (view instanceof MarkdownView && view.file) {
        void reResolveLinks(plugin, editor, view);
      }
    },
  });

  plugin.addCommand({
    id: 'reresolve-drive-links-vault',
    name: 'Re-resolve Drive image links in vault',
    callback: () => void reResolveVault(plugin),
  });

  plugin.addCommand({
    id: 'delete-removed-images-from-drive',
    name: 'Delete removed images from Drive',
    callback: () => void deletePendingFromDrive(plugin),
  });
}
