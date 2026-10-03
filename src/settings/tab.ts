import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type DriveImagesPlugin from '../plugin/main';
import type { EmbedFormat } from '../drive/types';
import { UnauthorizedError } from '../drive/client';
import { deletePendingFromDrive } from '../plugin/driveTrash';

export class DriveImagesSettingTab extends PluginSettingTab {
  plugin: DriveImagesPlugin;

  constructor(app: App, plugin: DriveImagesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    const { settings } = this.plugin;
    this.plugin.onPendingChanged = () => this.display();
    containerEl.empty();
    containerEl.addClass('od-settings');

    const save = (fn: () => void) => {
      fn();
      void this.plugin.saveSettings();
    };

    // ── Account ────────────────────────────────────────────────────────────
    const signedIn = !!settings.tokens;
    const account = containerEl.createDiv({ cls: 'od-card od-account' });
    account.createSpan({ cls: `od-dot ${signedIn ? 'is-on' : ''}` });
    const accountText = account.createDiv({ cls: 'od-card-text' });
    accountText.createDiv({
      cls: 'od-card-title',
      text: signedIn ? 'Connected to Google Drive' : 'Not connected',
    });
    accountText.createDiv({
      cls: 'od-card-sub',
      text: signedIn
        ? `Uploading to ${settings.folderName || 'Drive root'}`
        : 'Add your credentials below, then sign in.',
    });
    const accountBtn = account.createEl('button', {
      text: signedIn ? 'Sign out' : 'Sign in',
      cls: signedIn ? '' : 'mod-cta',
    });
    accountBtn.addEventListener('click', () => {
      void (async () => {
        accountBtn.disabled = true;
        accountBtn.setText(signedIn ? 'Signing out…' : 'Signing in…');
        try {
          await (signedIn ? this.plugin.signOut() : this.plugin.signIn());
        } finally {
          this.display();
        }
      })();
    });

    // Credentials are one-time setup: tucked away once the account is connected.
    const creds = this.section(containerEl, 'Credentials', !signedIn);
    new Setting(creds)
      .setName('Client ID')
      .setDesc('OAuth client of type "TVs and Limited Input devices".')
      .addText((text) =>
        text
          .setPlaceholder('xxxxx.apps.googleusercontent.com')
          .setValue(settings.clientId)
          .onChange((v) => save(() => (settings.clientId = v.trim()))),
      );
    new Setting(creds)
      .setName('Client secret')
      .setDesc('Not confidential in the device flow, but keep it private.')
      .addText((text) => {
        text.setValue(settings.clientSecret).onChange((v) => save(() => (settings.clientSecret = v.trim())));
        text.inputEl.type = 'password';
      });

    // ── Storage ────────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Storage').setHeading();

    new Setting(containerEl)
      .setName('Folder')
      .setDesc('Drive folder for uploads. Use / for subfolders.')
      .addText((text) =>
        text
          .setPlaceholder('Obsidian Images')
          .setValue(settings.folderName)
          .onChange((v) => save(() => (settings.folderName = v.trim()))),
      )
      .addExtraButton((btn) =>
        btn
          .setIcon('folder-sync')
          .setTooltip('Create or connect this folder now')
          .onClick(async () => {
            btn.setDisabled(true);
            try {
              await this.ensureFolder();
            } finally {
              btn.setDisabled(false);
            }
          }),
      );

    new Setting(containerEl)
      .setName('Public links')
      .setDesc('Let anyone with the link view uploads, so images render in notes.')
      .addToggle((t) => t.setValue(settings.makePublic).onChange((v) => save(() => (settings.makePublic = v))));

    new Setting(containerEl)
      .setName('Link format')
      .setDesc('The URL style written into notes.')
      .addDropdown((dd) =>
        dd
          .addOption('lh3', 'lh3 (fastest)')
          .addOption('thumbnail', 'Thumbnail')
          .addOption('apiMedia', 'API media')
          .setValue(settings.embedFormat)
          .onChange((v) => save(() => (settings.embedFormat = v as EmbedFormat))),
      );

    // ── Clean up ───────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Clean up').setHeading();

    new Setting(containerEl)
      .setName('Track removed images')
      .setDesc('List images you delete from your notes. Undo takes them off the list.')
      .addToggle((t) =>
        t.setValue(settings.trackRemovedImages).onChange((v) => save(() => (settings.trackRemovedImages = v))),
      );

    const pending = Object.keys(settings.pendingDeletes).length;
    const card = containerEl.createDiv({ cls: 'od-card od-pending' });
    card.createSpan({ cls: 'od-count', text: String(pending) });
    const cardText = card.createDiv({ cls: 'od-card-text' });
    cardText.createDiv({
      cls: 'od-card-title',
      text: pending === 1 ? 'Image waiting to be deleted' : 'Images waiting to be deleted',
    });
    cardText.createDiv({
      cls: 'od-card-sub',
      text: 'Moved to the Drive trash, recoverable for 30 days. Images still in use are skipped.',
    });
    const delBtn = card.createEl('button', { text: 'Delete from Drive', cls: 'mod-warning' });
    delBtn.disabled = pending === 0;
    delBtn.addEventListener('click', () => {
      void (async () => {
        delBtn.disabled = true;
        delBtn.setText('Deleting…');
        try {
          await deletePendingFromDrive(this.plugin);
        } finally {
          this.display();
        }
      })();
    });

    new Setting(containerEl)
      .setName('Trash local copy after converting')
      .setDesc('When converting local images to Drive links, move the original file to the system trash.')
      .addToggle((t) =>
        t.setValue(settings.deleteLocalAfterConvert).onChange((v) => save(() => (settings.deleteLocalAfterConvert = v))),
      );

    // ── Advanced ───────────────────────────────────────────────────────────
    const advanced = this.section(containerEl, 'Advanced', false);
    new Setting(advanced)
      .setName('Parent folder ID')
      .setDesc('Create the folder inside this existing Drive folder (ID from its URL). Empty uses My Drive.')
      .addText((text) =>
        text
          .setPlaceholder('1AbC…')
          .setValue(settings.parentFolderId)
          .onChange((v) => save(() => (settings.parentFolderId = v.trim()))),
      );
  }

  /** A collapsible group of settings. */
  private section(parent: HTMLElement, title: string, open: boolean): HTMLElement {
    const details = parent.createEl('details', { cls: 'od-section' });
    details.open = open;
    details.createEl('summary', { text: title });
    return details.createDiv({ cls: 'od-section-body' });
  }

  hide(): void {
    this.plugin.onPendingChanged = undefined;
  }

  /**
   * Find-or-create the plugin-owned folder named `folderName` and cache its id.
   * Since the plugin owns the folder, this genuinely verifies/creates it under
   * the drive.file scope.
   */
  private async ensureFolder(): Promise<void> {
    const name = this.plugin.settings.folderName;
    if (!name) {
      new Notice('Enter a folder name first.');
      return;
    }
    if (!this.plugin.settings.tokens) {
      new Notice('Sign in to Google Drive first.');
      return;
    }
    try {
      const { created } = await this.plugin.ensureFolderInfo();
      new Notice(
        created ? `Created folder: "${name}"` : `Connected to existing folder: "${name}"`,
      );
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        new Notice('Sign in to Google Drive first.');
        return;
      }
      new Notice(`Could not create/connect folder: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
