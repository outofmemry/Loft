import type { RequestFn, UploadResult } from './types';

const UPLOAD_URL =
  'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';

/** Thrown on a 401 so callers can refresh the token and retry once. */
export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized (401)') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

function concatUint8(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Minimal Drive REST client. Obsidian-agnostic: HTTP via injected RequestFn,
 * access token via injected async getter.
 */
export class DriveClient {
  constructor(
    private readonly request: RequestFn,
    private readonly getAccessToken: () => Promise<string>,
  ) {}

  /**
   * Upload a file to `folderId` in a single multipart/related request.
   * Returns the created file's id. Throws UnauthorizedError on 401.
   */
  async upload(
    fileName: string,
    mime: string,
    data: ArrayBuffer,
    folderId: string,
  ): Promise<UploadResult> {
    const token = await this.getAccessToken();
    const boundary = `odiu-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const enc = new TextEncoder();

    const metadata = JSON.stringify({ name: fileName, parents: [folderId] });

    const part1 =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${metadata}\r\n`;
    const part2Header = `--${boundary}\r\n` + `Content-Type: ${mime}\r\n\r\n`;
    const closing = `\r\n--${boundary}--\r\n`;

    const body = concatUint8([
      enc.encode(part1),
      enc.encode(part2Header),
      new Uint8Array(data),
      enc.encode(closing),
    ]);

    // Copy into a fresh ArrayBuffer (concatUint8 already owns exactly the used
    // bytes, so .buffer is the correct backing store).
    const bodyBuffer = body.buffer as ArrayBuffer;

    const res = await this.request({
      url: UPLOAD_URL,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      contentType: `multipart/related; boundary=${boundary}`,
      body: bodyBuffer,
    });

    if (res.status === 401) throw new UnauthorizedError();
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Upload failed (${res.status}): ${res.text}`);
    }
    return { id: (res.json as { id: string }).id };
  }

  /**
   * Move a file to (or restore it from) the Drive trash. Deliberately a trash
   * flag rather than a permanent delete: it is reversible, which is what makes
   * editor undo safe. Drive purges trashed files itself after 30 days.
   * Returns 'missing' if the file no longer exists (404), which callers treat
   * as already-gone. Throws UnauthorizedError on 401.
   */
  async setTrashed(fileId: string, trashed: boolean): Promise<'ok' | 'missing'> {
    const token = await this.getAccessToken();
    const res = await this.request({
      url: `${FILES_URL}/${fileId}?fields=id`,
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
      contentType: 'application/json',
      body: JSON.stringify({ trashed }),
    });
    if (res.status === 401) throw new UnauthorizedError();
    if (res.status === 404) return 'missing';
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`${trashed ? 'Trash' : 'Restore'} failed (${res.status}): ${res.text}`);
    }
    return 'ok';
  }

  /**
   * Make the file readable by anyone with the link. Required for direct render.
   */
  async share(fileId: string): Promise<void> {
    const token = await this.getAccessToken();
    const res = await this.request({
      url: `${FILES_URL}/${fileId}/permissions`,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      contentType: 'application/json',
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    });
    if (res.status === 401) throw new UnauthorizedError();
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Share failed (${res.status}): ${res.text}`);
    }
  }
}
