/**
 * Runtime Resource Manager
 *
 * Handles loading of assets and resources for the runtime.
 * Supports loading from:
 * - res:// (mapped to base public URL)
 * - file:// (not really supported in web, but mapped to URL)
 * - http:// / https://
 * - blob: / data:
 */

/**
 * A resource baked into a single-file build: bytes as base64, or — for a text file (an SVG, a
 * scene as JSON, an atlas) — the text itself, a quarter smaller than its base64 and far better
 * for the page's own gzip.
 */
export type EmbeddedResourceEntry =
  | { readonly base64: string; readonly mimeType?: string }
  | { readonly text: string; readonly mimeType?: string };

export type EmbeddedResourceMap = Record<string, EmbeddedResourceEntry>;

export class ResourceManager {
  private baseUrl: string;
  private readonly embeddedResources: Map<string, EmbeddedResourceEntry>;
  private audioBuffers = new Map<string, AudioBuffer>();

  constructor(baseUrl: string = '/', embeddedResources: EmbeddedResourceMap = {}) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    this.embeddedResources = new Map<string, EmbeddedResourceEntry>();

    for (const [path, entry] of Object.entries(embeddedResources)) {
      const normalizedPath = this.normalizeEmbeddedPath(path);
      this.embeddedResources.set(normalizedPath, entry);
    }
  }

  /**
   * Normalize a resource path to a full URL.
   */
  normalize(resource: string): string {
    const scheme = this.getScheme(resource);

    if (scheme === 'res') {
      const path = resource.substring(6); // remove res://
      return this.buildUrl(path);
    }

    if (scheme === 'http' || scheme === 'https' || scheme === 'blob' || scheme === 'data') {
      return resource;
    }

    // Default to relative path from base
    return this.buildUrl(resource);
  }

  getAudioBuffer(key: string): AudioBuffer | undefined {
    return this.audioBuffers.get(key);
  }

  setAudioBuffer(key: string, buffer: AudioBuffer): void {
    this.audioBuffers.set(key, buffer);
  }

  async readText(resource: string): Promise<string> {
    const embeddedEntry = this.getEmbeddedEntry(resource);
    if (embeddedEntry) {
      if ('text' in embeddedEntry) return embeddedEntry.text;
      const bytes = this.decodeBase64ToBytes(embeddedEntry.base64);
      return new TextDecoder().decode(bytes);
    }

    const url = this.normalize(resource);
    return await this.fetchText(url);
  }

  async readBlob(resource: string): Promise<Blob> {
    const embeddedEntry = this.getEmbeddedEntry(resource);
    if (embeddedEntry) {
      if ('text' in embeddedEntry) {
        return new Blob([embeddedEntry.text], {
          type: embeddedEntry.mimeType ?? 'text/plain',
        });
      }
      const bytes = this.decodeBase64ToBytes(embeddedEntry.base64);
      const blobBytes = new Uint8Array(bytes.byteLength);
      blobBytes.set(bytes);
      return new Blob([blobBytes], {
        type: embeddedEntry.mimeType ?? 'application/octet-stream',
      });
    }

    const url = this.normalize(resource);
    return await this.fetchBlob(url);
  }

  protected async fetchText(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching ${url}`);
    }
    return await response.text();
  }

  protected async fetchBlob(url: string): Promise<Blob> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching blob from ${url}`);
    }
    return await response.blob();
  }

  /**
   * The URL scheme, lower-case, or `''` for a plain (project-relative) path. `data:` and `blob:`
   * URLs have no `//` after the colon, so they are matched by name.
   */
  protected getScheme(resource: string): string {
    const trimmed = resource.trim();
    const match = /^([a-z]+[a-z0-9+.-]*):\/\//i.exec(trimmed) ?? /^(data|blob):/i.exec(trimmed);
    if (!match) {
      return '';
    }
    return match[1].toLowerCase();
  }

  protected buildUrl(relativePath: string): string {
    const trimmedPath = relativePath.replace(/^\/+/, '');
    return `${this.baseUrl}${trimmedPath}`;
  }

  private getEmbeddedEntry(resource: string): EmbeddedResourceEntry | null {
    const path = this.toEmbeddedPath(resource);
    if (!path) {
      return null;
    }

    return this.embeddedResources.get(path) ?? null;
  }

  private toEmbeddedPath(resource: string): string | null {
    const scheme = this.getScheme(resource);

    if (scheme === 'res') {
      return this.normalizeEmbeddedPath(resource.substring(6));
    }

    if (!scheme) {
      return this.normalizeEmbeddedPath(resource);
    }

    return null;
  }

  private normalizeEmbeddedPath(path: string): string {
    return path.replace(/\\/g, '/').replace(/^\/+/, '');
  }

  private decodeBase64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  }
}
