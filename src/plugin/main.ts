import { Notice, Plugin, requestUrl } from 'obsidian';
import { DEFAULT_SETTINGS, type Settings } from '../settings/data';
import { DriveImagesSettingTab } from '../settings/tab';
import { DeviceFlowAuth } from '../drive/auth';
import { UnauthorizedError } from '../drive/client';
import { ensureFolderPath, folderExists } from '../drive/folder';
import { DataJsonTokenStore, type TokenStore } from '../drive/tokenStore';
import type { RequestFn } from '../drive/types';
import { retryWithBackoff, parseRetryAfter, expoDelay } from '../drive/retry';
import { registerCommands } from './commands';
import { registerConvertContextMenu } from './contextMenu';
import { registerImageUploadHandlers } from '../editor/pasteHandler';
import { registerDriveTrashSync } from './driveTrash';
import { DeviceCodeModal } from '../ui/deviceCodeModal';

// Refresh access tokens this many ms before their nominal expiry to avoid
// racing the clock on a slow request.
const EXPIRY_SKEW_MS = 60_000;

export default class DriveImagesPlugin extends Plugin {
  settings!: Settings;

  /** Set by the settings tab while open so its pending-deletion count stays live. */
  onPendingChanged?: () => void;

  // Serializes ensureFolderId: while one find-or-create resolution is running,
  // concurrent callers (settings button double-click, a paste firing at the same
  // time) share this single in-flight promise instead of each launching their own
  // search+create — which would race two "not found" checks into duplicate folders.
  private ensureFolderInFlight: Promise<{ id: string; created: boolean }> | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new DriveImagesSettingTab(this.app, this));
    registerCommands(this);
    registerConvertContextMenu(this);
    registerImageUploadHandlers(this);
    registerDriveTrashSync(this);
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as Settings;
    // Shallow merge would alias DEFAULT_SETTINGS' maps when saved data lacks them.
    this.settings.uploadCache = { ...this.settings.uploadCache };
    this.settings.pendingDeletes = { ...this.settings.pendingDeletes };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Content-hash dedup lookup: returns a previously uploaded fileId, if any. */
  getCachedFileId(hash: string): string | undefined {
    return this.settings.uploadCache[hash];
  }

  /** True if this Drive file was uploaded by this plugin (so it is ours to trash). */
  isUploadedFileId(id: string): boolean {
    return id in this.settings.pendingDeletes || Object.values(this.settings.uploadCache).includes(id);
  }

  /** Record a content-hash → fileId mapping and persist it. */
  async setCachedFileId(hash: string, fileId: string): Promise<void> {
    this.settings.uploadCache[hash] = fileId;
    await this.saveSettings();
  }

  /**
   * Adapter mapping Obsidian's requestUrl to the drive layer's RequestFn.
   * `throw: false` so non-2xx bodies (e.g. authorization_pending) are readable.
   * This is the only place requestUrl is imported.
   *
   * The raw request is wrapped in `retryWithBackoff` so every Drive call
   * (upload/share/folder/token) transparently retries on 429/5xx and transient
   * network errors, honoring the `Retry-After` header when present. The external
   * shape/signature of the adapter is unchanged.
   */
  getRequest(): RequestFn {
    const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
    return async (opts) => {
      const res = await retryWithBackoff(
        () =>
          requestUrl({
            url: opts.url,
            method: opts.method ?? 'GET',
            headers: buildHeaders(opts.headers, opts.contentType),
            body: opts.body,
            throw: false,
          }),
        {
          isRetryable: (r) => r.status === 429 || (r.status >= 500 && r.status < 600),
          retryDelayMs: (r, attempt) =>
            parseRetryAfter(r.headers?.['retry-after']) ?? expoDelay(attempt),
          // Retry a couple of times on thrown (network) errors before giving up.
          onNetworkError: (_err, attempt) => (attempt <= 2 ? expoDelay(attempt) : null),
          sleep,
        },
      );
      return {
        status: res.status,
        text: res.text,
        json: safeJson(res),
        arrayBuffer: res.arrayBuffer,
      };
    };
  }

  getAuth(): DeviceFlowAuth {
    return new DeviceFlowAuth(this.getRequest(), this.settings.clientId, this.settings.clientSecret);
  }

  getTokenStore(): TokenStore {
    return new DataJsonTokenStore(
      () => this.loadData() as Promise<Settings | null>,
      async (data) => {
        // Keep the in-memory settings and the persisted blob in sync.
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
        await this.saveData(this.settings);
      },
    );
  }

  /** Return a valid access token, refreshing via the refresh token if expired. */
  async getAccessToken(): Promise<string> {
    const tokens = this.settings.tokens;
    if (!tokens) throw new Error('Not authenticated.');
    if (Date.now() < tokens.expiresAt - EXPIRY_SKEW_MS) {
      return tokens.accessToken;
    }
    return this.refreshAccessToken();
  }

  /**
   * Resolve (find-or-create) the plugin-owned folder PATH `folderName` under the
   * optional `parentFolderId`, and cache the final folder id in settings. A fast
   * path returns the cached id (guarded by a cache key of parent+path) when it
   * still points at a valid folder, skipping the walk. On a 401 refresh the
   * access token once and retry.
   */
  async ensureFolderId(): Promise<string> {
    return (await this.ensureFolderInfo()).id;
  }

  /**
   * Like {@link ensureFolderId} but also reports whether the folder was newly
   * created (`created: true`) versus an existing one reused (`created: false`).
   * This IS the single-flight gate: concurrent callers share one in-flight
   * resolution so a double-click or a paste racing the settings button can't
   * create the folder twice.
   */
  async ensureFolderInfo(): Promise<{ id: string; created: boolean }> {
    if (this.ensureFolderInFlight) return this.ensureFolderInFlight;
    this.ensureFolderInFlight = this.resolveFolderId();
    try {
      return await this.ensureFolderInFlight;
    } finally {
      this.ensureFolderInFlight = null;
    }
  }

  private async resolveFolderId(): Promise<{ id: string; created: boolean }> {
    const request = this.getRequest();
    const getToken = () => this.getAccessToken();
    const key = `${this.settings.parentFolderId}|${this.settings.folderName}`;

    const run = async (): Promise<{ id: string; created: boolean; fromCache: boolean }> => {
      if (
        this.settings.folderId &&
        this.settings.folderCacheKey === key &&
        (await folderExists(request, getToken, this.settings.folderId))
      ) {
        return { id: this.settings.folderId, created: false, fromCache: true };
      }
      const { id, created } = await ensureFolderPath(
        request,
        getToken,
        this.settings.folderName,
        this.settings.parentFolderId || undefined,
      );
      return { id, created, fromCache: false };
    };

    let result;
    try {
      result = await run();
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        await this.refreshAccessToken();
        result = await run();
      } else {
        throw e;
      }
    }

    if (!result.fromCache) {
      this.settings.folderId = result.id;
      this.settings.folderCacheKey = key;
      await this.saveSettings();
    }
    return { id: result.id, created: result.created };
  }

  /** Force a refresh and persist the new token set. Returns the access token. */
  async refreshAccessToken(): Promise<string> {
    const tokens = this.settings.tokens;
    if (!tokens?.refreshToken) throw new Error('No refresh token; please re-authenticate.');
    const next = await this.getAuth().refresh(tokens.refreshToken);
    this.settings.tokens = next;
    await this.saveSettings();
    return next.accessToken;
  }

  /**
   * Run the full Google Drive device-flow sign-in: request a device code, show
   * the DeviceCodeModal, poll for a token, then persist it. Shared by both the
   * command palette and the settings tab button.
   */
  async signIn(): Promise<void> {
    const { clientId, clientSecret } = this.settings;
    if (!clientId || !clientSecret) {
      new Notice('Set your Client ID and Client Secret in the plugin settings first.');
      return;
    }

    const auth = this.getAuth();
    let modal: DeviceCodeModal | undefined;
    try {
      const device = await auth.requestDeviceCode();
      modal = new DeviceCodeModal(this.app, device.user_code, device.verification_url);
      modal.open();

      const token = await auth.pollForToken(
        device.device_code,
        device.interval,
        device.expires_in,
        () => modal!.isCancelled(),
      );

      await this.getTokenStore().save(token);
      this.settings.tokens = token;
      await this.saveSettings();
      modal.setStatus('Authenticated!');
      modal.close();
      new Notice('Signed in to Google Drive.');
    } catch (e) {
      modal?.close();
      new Notice(`Sign-in failed: ${errorMessage(e)}`);
    }
  }

  /** Clear stored Google Drive tokens. Shared by the command and settings tab. */
  async signOut(): Promise<void> {
    if (!this.settings.tokens) {
      new Notice('Not signed in to Google Drive.');
      return;
    }
    try {
      await this.getTokenStore().clear();
      this.settings.tokens = null;
      await this.saveSettings();
      new Notice('Signed out of Google Drive.');
    } catch (e) {
      new Notice(`Sign-out failed: ${errorMessage(e)}`);
    }
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function buildHeaders(
  headers: Record<string, string> | undefined,
  contentType: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = { ...(headers ?? {}) };
  if (contentType) out['Content-Type'] = contentType;
  return out;
}

// requestUrl exposes `.json` but throws if the body is not JSON; guard it.
function safeJson(res: { text: string }): unknown {
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}
