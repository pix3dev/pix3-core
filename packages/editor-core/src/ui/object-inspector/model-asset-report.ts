import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { resolveProjectStorageService } from '@/services/project/ProjectStorageService';
import { IconService, IconSize } from '@/services/editor/IconService';
import { resolveGltfRelativePath } from '@/services/assets/GltfBlobLoader';
import { inspectGltf, type GltfInspectReport } from '@/services/assets/gltf-inspect';
import { formatBytes } from '@/ui/shared/format-bytes';
import './model-asset-report.ts.css';

type ReportState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; report: GltfInspectReport }
  | { kind: 'error'; message: string };

/**
 * "Inspect model" in the Asset Inspector: on request, reads a `.glb` / `.gltf` and lists what is
 * inside — meshes, textures (format, pixel size), materials, animations — each with its bytes and
 * share of the whole file. Nothing is read until the button is pressed; a new asset resets it.
 */
@customElement('pix3-model-asset-report')
export class ModelAssetReport extends ComponentBase {
  @inject(IconService)
  private readonly iconService!: IconService;

  private readonly storage = resolveProjectStorageService();

  @property({ type: String })
  resourcePath: string = '';

  @state()
  private reportState: ReportState = { kind: 'idle' };

  private requestVersion = 0;

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has('resourcePath') && changed.get('resourcePath') !== undefined) {
      this.requestVersion += 1;
      this.reportState = { kind: 'idle' };
    }
  }

  protected render() {
    const current = this.reportState;
    if (current.kind === 'idle' || current.kind === 'error') {
      return html`
        <button class="inspector-btn" type="button" @click=${() => void this.inspect()}>
          ${this.iconService.getIcon('search', IconSize.SMALL)}
          <span>Inspect model</span>
        </button>
        ${current.kind === 'error'
          ? html`<div class="model-report-error">${current.message}</div>`
          : null}
      `;
    }
    if (current.kind === 'loading') {
      return html`<div class="model-report-status">Reading model…</div>`;
    }
    return this.renderReport(current.report);
  }

  private async inspect(): Promise<void> {
    const path = this.resourcePath;
    if (!path) {
      return;
    }
    const version = ++this.requestVersion;
    this.reportState = { kind: 'loading' };
    try {
      const bytes = new Uint8Array(await (await this.storage.readBlob(path)).arrayBuffer());
      const report = await inspectGltf(bytes, {
        readExternal: async uri =>
          new Uint8Array(
            await (await this.storage.readBlob(resolveGltfRelativePath(path, uri))).arrayBuffer()
          ),
      });
      if (version === this.requestVersion) {
        this.reportState = { kind: 'ready', report };
      }
    } catch (error) {
      if (version === this.requestVersion) {
        const message = error instanceof Error ? error.message : String(error);
        this.reportState = { kind: 'error', message: `Cannot read model: ${message}` };
      }
    }
  }

  private renderReport(report: GltfInspectReport) {
    const total = report.totalBytes;
    const sum = (items: Array<{ bytes: number }>) =>
      items.reduce((acc, item) => acc + item.bytes, 0);
    const parts = [
      { key: 'textures', label: 'Textures', bytes: sum(report.textures) },
      { key: 'geometry', label: 'Geometry', bytes: sum(report.meshes) },
      { key: 'animation', label: 'Animation', bytes: sum(report.animations) + report.skinBytes },
      { key: 'json', label: 'JSON', bytes: report.jsonBytes },
      { key: 'other', label: 'Other', bytes: report.otherBinaryBytes },
    ].filter(part => part.bytes > 0);

    const meshes = [...report.meshes].sort((a, b) => b.bytes - a.bytes);
    const textures = [...report.textures].sort((a, b) => b.bytes - a.bytes);
    const animations = [...report.animations].sort((a, b) => b.bytes - a.bytes);

    return html`
      <div class="model-report">
        <div class="model-report-head">
          <span class="model-report-total">${formatBytes(total)}</span>
          <span class="model-report-counts">
            ${[
              plural(report.meshes.length, 'mesh', 'meshes'),
              plural(report.totalVertices, 'vert'),
              plural(report.totalTriangles, 'tri'),
              plural(report.materials.length, 'material'),
              plural(report.textures.length, 'texture'),
              report.animations.length ? plural(report.animations.length, 'animation') : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <button
            class="inspector-btn inspector-btn--icon"
            type="button"
            title="Close report"
            aria-label="Close model report"
            @click=${() => {
              this.reportState = { kind: 'idle' };
            }}
          >
            ${this.iconService.getIcon('x', IconSize.SMALL)}
          </button>
        </div>

        <div class="model-report-bar" role="img" aria-label="Share of file size by kind">
          ${parts.map(
            part =>
              html`<span
                class="model-report-bar-part model-report-bar-part--${part.key}"
                style="flex-grow:${part.bytes}"
                title="${part.label}: ${formatBytes(part.bytes)} (${percent(part.bytes, total)})"
              ></span>`
          )}
        </div>
        <div class="model-report-legend">
          ${parts.map(
            part => html`
              <span class="model-report-legend-item">
                <span class="model-report-swatch model-report-bar-part--${part.key}"></span>
                ${part.label} ${percent(part.bytes, total)}
              </span>
            `
          )}
        </div>

        ${textures.length
          ? this.renderTable(
              'Textures',
              ['Image', 'Format', 'Size', 'Bytes', '%'],
              textures.map(texture => ({
                cells: [
                  texture.name,
                  texture.format,
                  texture.width !== null && texture.height !== null
                    ? `${texture.width}×${texture.height}`
                    : '—',
                  formatBytes(texture.bytes),
                  percent(texture.bytes, total),
                ],
                title: [
                  texture.storage === 'embedded' ? null : texture.storage,
                  texture.usedBy.length ? `Used by: ${texture.usedBy.join(', ')}` : 'Unused',
                ]
                  .filter(Boolean)
                  .join('\n'),
                share: texture.bytes / (total || 1),
              }))
            )
          : null}
        ${meshes.length
          ? this.renderTable(
              'Meshes',
              ['Mesh', 'Verts', 'Tris', 'Bytes', '%'],
              meshes.map(mesh => ({
                cells: [
                  mesh.compression ? `${mesh.name} (${mesh.compression})` : mesh.name,
                  formatCount(mesh.vertices),
                  formatCount(mesh.triangles),
                  formatBytes(mesh.bytes),
                  percent(mesh.bytes, total),
                ],
                title: [
                  `${mesh.primitives} primitive${mesh.primitives === 1 ? '' : 's'}`,
                  `Attributes: ${mesh.attributes.join(', ') || '—'}`,
                  `Materials: ${mesh.materials.join(', ') || '—'}`,
                ].join('\n'),
                share: mesh.bytes / (total || 1),
              }))
            )
          : null}
        ${report.materials.length
          ? this.renderTable(
              'Materials',
              ['Material', 'Shading', 'Maps', 'Tex bytes', '%'],
              report.materials.map(material => ({
                cells: [
                  material.name,
                  material.shading,
                  material.textures.map(texture => texture.slot).join(', ') || '—',
                  formatBytes(material.textureBytes),
                  percent(material.textureBytes, total),
                ],
                title: [
                  `Alpha: ${material.alphaMode}${material.doubleSided ? ' · double-sided' : ''}`,
                  ...material.textures.map(texture => `${texture.slot}: ${texture.image}`),
                ].join('\n'),
                share: material.textureBytes / (total || 1),
              }))
            )
          : null}
        ${animations.length
          ? this.renderTable(
              'Animations',
              ['Clip', 'Channels', 'Length', 'Bytes', '%'],
              animations.map(animation => ({
                cells: [
                  animation.name,
                  String(animation.channels),
                  animation.durationSeconds === null
                    ? '—'
                    : `${animation.durationSeconds.toFixed(2)} s`,
                  formatBytes(animation.bytes),
                  percent(animation.bytes, total),
                ],
                title: '',
                share: animation.bytes / (total || 1),
              }))
            )
          : null}

        <div class="model-report-meta">
          <span
            >${report.container.toUpperCase()} · ${report.nodes}
            nodes${report.skins ? ` · ${report.skins} skins` : ''}</span
          >
          ${report.externalBytes > 0
            ? html`<span>External files: ${formatBytes(report.externalBytes)}</span>`
            : null}
          ${report.extensionsUsed.length
            ? html`<span>Extensions: ${report.extensionsUsed.join(', ')}</span>`
            : null}
          ${report.generator ? html`<span>Generator: ${report.generator}</span>` : null}
          ${report.warnings.map(
            warning => html`<span class="model-report-warning">${warning}</span>`
          )}
        </div>
      </div>
    `;
  }

  private renderTable(
    title: string,
    columns: string[],
    rows: Array<{ cells: string[]; title: string; share: number }>
  ) {
    return html`
      <details class="model-report-section" open>
        <summary>${title} <span class="model-report-section-count">${rows.length}</span></summary>
        <div class="model-report-table-wrap">
          <table class="model-report-table">
            <thead>
              <tr>
                ${columns.map(column => html`<th>${column}</th>`)}
              </tr>
            </thead>
            <tbody>
              ${rows.map(
                row => html`
                  <tr title=${row.title}>
                    ${row.cells.map(
                      (cell, index) =>
                        html`<td class=${index === 0 ? 'model-report-name' : ''}>
                          ${index === row.cells.length - 1
                            ? html`<span
                                  class="model-report-share"
                                  style="width:${Math.min(100, row.share * 100).toFixed(1)}%"
                                ></span
                                ><span class="model-report-share-text">${cell}</span>`
                            : cell}
                        </td>`
                    )}
                  </tr>
                `
              )}
            </tbody>
          </table>
        </div>
      </details>
    `;
  }
}

function percent(part: number, total: number): string {
  if (total <= 0) {
    return '—';
  }
  const value = (part / total) * 100;
  return value > 0 && value < 0.1 ? '<0.1%' : `${value.toFixed(1)}%`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-model-asset-report': ModelAssetReport;
  }
}
