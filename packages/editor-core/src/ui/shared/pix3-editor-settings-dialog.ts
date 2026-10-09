import { dismissOnBackdropClick } from '@/ui/shared/backdrop-dismiss';
import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { appState } from '@/state';
import {
  EditorSettingsService,
  type EditorSettingsTab,
} from '@/services/editor/EditorSettingsService';
import { OperationService } from '@/services/core/OperationService';
import { UpdateEditorSettingsOperation } from '@/features/editor/UpdateEditorSettingsOperation';
import { AiImageSettingsService } from '@/services/image-gen/AiImageSettingsService';
import { ImageGenProviderRegistry } from '@/services/image-gen/ImageGenProviderRegistry';
import { modelPickerLabel } from '@/services/image-gen/ImageGenTypes';
import { IconService, IconSize } from '@/services/editor/IconService';
import { HostService } from '@/host/HostService';
import type { Navigation2DSettings } from '@/state/AppState';
import { CURRENT_EDITOR_VERSION } from '@/version';
import './pix3-editor-settings-dialog.ts.css';

interface SettingsSubtab {
  id: string;
  label: string;
}

/**
 * Public product links surfaced in Settings → About: the one place in the editor that says where
 * Pix3 lives outside this tab.
 */
const PIX3_LINKS: readonly { href: string; icon: string; label: string; hint: string }[] = [
  {
    href: 'https://pix3.dev',
    icon: 'globe',
    label: 'pix3.dev',
    hint: 'Project landing page — what Pix3 is, what it does, and where it is going.',
  },
  {
    href: 'https://github.com/pix3dev/pix3',
    icon: 'github',
    label: 'github.com/pix3dev/pix3',
    hint: 'Source, issue tracker and releases.',
  },
];

interface SettingsSectionDef {
  id: EditorSettingsTab;
  label: string;
  /** Feather / custom IconService id shown in the sidebar. */
  icon: string;
  /** Optional one-line description shown under the pane title. */
  description?: string;
  /** Sub-tabs rendered at the top of the pane; omit for single-view sections. */
  subtabs?: readonly SettingsSubtab[];
}

/**
 * Godot-style layout: the sidebar lists the main sections; a section with a lot
 * of content splits into sub-tabs rendered at the top of the content pane.
 */
const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { id: 'general', label: 'General', icon: 'sliders' },
  {
    id: 'images',
    label: 'AI Images',
    icon: 'image',
    description: 'Image generation used by the Generate panel.',
  },
  {
    id: 'about',
    label: 'About',
    icon: 'info',
    description: 'Versions, and where to find Pix3 outside this tab.',
  },
];

/**
 * Editor Settings: General (editor behaviour), AI Images (provider, model, key) and About. Editor
 * preferences flow through `UpdateEditorSettingsOperation` on Save; AI image preferences and keys
 * are saved as they change (they belong to `AiImageSettingsService`, not to appState).
 */
@customElement('pix3-editor-settings-dialog')
export class EditorSettingsDialog extends ComponentBase {
  @inject(EditorSettingsService)
  private readonly editorSettingsService!: EditorSettingsService;

  @inject(OperationService)
  private readonly operationService!: OperationService;

  @inject(AiImageSettingsService)
  private readonly aiImageSettings!: AiImageSettingsService;

  @inject(ImageGenProviderRegistry)
  private readonly imageProviders!: ImageGenProviderRegistry;

  @inject(IconService)
  private readonly icons!: IconService;

  @inject(HostService)
  private readonly hostService!: HostService;

  @state()
  private activeSection: EditorSettingsTab = 'general';

  /**
   * Keys of the explanations currently expanded. Every note in this dialog lives behind an (i)
   * toggle: the prose is worth keeping but stacked permanently under every field it buried the
   * controls.
   */
  @state()
  private openNotes: readonly string[] = [];

  /** Keys of the API-key rows currently expanded — a key is entered once and then stays put. */
  @state()
  private openKeys: readonly string[] = [];

  /** Active sub-tab id within the current section (empty when the section has none). */
  @state()
  private activeSubtab = '';

  @state()
  @state()
  private pauseRenderingOnUnfocus = true;

  @state()
  private keepEditorRunningForAgent = true;

  @state()
  private navigation2D: Navigation2DSettings = {
    panSensitivity: 0.75,
    zoomSensitivity: 0.001,
  };

  @state()
  private aiProviderId = '';

  @state()
  private aiModelId = '';

  @state()
  private aiKeyConfigured = false;

  @state()
  private aiKeyInput = '';

  @state()
  private aiKeyBusy = false;

  @state()
  private aiKeyMessage: string | null = null;

  @state()
  private defaultSaveMaxSize = 0;

  connectedCallback(): void {
    super.connectedCallback();
    this.activeSection = this.editorSettingsService.getInitialTab();
    this.activeSubtab = this.defaultSubtab(this.activeSection);
    this.pauseRenderingOnUnfocus = appState.ui.pauseRenderingOnUnfocus;
    this.keepEditorRunningForAgent = appState.ui.keepEditorRunningForAgent;
    this.navigation2D = { ...appState.ui.navigation2D };

    const prefs = this.aiImageSettings.getPreferences();
    this.aiProviderId = prefs.selectedProviderId || this.imageProviders.getDefault()?.id || '';
    this.aiModelId = this.aiImageSettings.getSelectedModelId(this.aiProviderId) ?? '';
    this.defaultSaveMaxSize = prefs.defaultSaveMaxSize;
    void this.refreshAiKeyStatus();
  }

  protected render() {
    const section =
      SETTINGS_SECTIONS.find(s => s.id === this.activeSection) ?? SETTINGS_SECTIONS[0];
    return html`
      <div class="dialog-backdrop" @click=${dismissOnBackdropClick(this.onCancel)}>
        <div class="dialog-content" @click=${(e: Event) => e.stopPropagation()}>
          <h2 class="dialog-title">Editor Settings</h2>

          <div class="settings-body">
            <nav class="settings-sidebar" role="tablist" aria-orientation="vertical">
              ${SETTINGS_SECTIONS.map(
                item => html`
                  <button
                    class="settings-nav-item ${item.id === this.activeSection ? 'is-active' : ''}"
                    role="tab"
                    aria-selected=${item.id === this.activeSection}
                    @click=${() => this.selectSection(item.id)}
                  >
                    <span class="nav-icon">${this.icons.getIcon(item.icon, IconSize.SMALL)}</span>
                    <span class="nav-label">${item.label}</span>
                  </button>
                `
              )}
            </nav>

            <div class="settings-pane">
              <div class="pane-header">
                <h3 class="pane-title">${section.label}</h3>
                ${section.description
                  ? html`<p class="pane-description">${section.description}</p>`
                  : null}
              </div>
              ${section.subtabs ? this.renderSubtabs(section.subtabs) : null}
              <div class="settings-form">${this.renderSectionContent(section)}</div>
            </div>
          </div>

          <div class="dialog-actions">
            <button class="btn-cancel" @click=${this.onCancel}>Cancel</button>
            <button class="btn-save" @click=${this.onSave}>Save Changes</button>
          </div>
        </div>
      </div>
    `;
  }

  /** An (i) button that reveals the note registered under `key` by {@link renderNote}. */
  private renderInfo(key: string, label = 'Explain this setting') {
    const open = this.openNotes.includes(key);
    return html`<button
      type="button"
      class="info-toggle ${open ? 'is-open' : ''}"
      aria-expanded=${open}
      aria-label=${label}
      title=${label}
      @click=${() => this.toggleNote(key)}
    >
      ${this.icons.getIcon('info', IconSize.SMALL)}
    </button>`;
  }

  /** The note for `key`, rendered only while its {@link renderInfo} toggle is on. */
  private renderNote(key: string, body: unknown) {
    return this.openNotes.includes(key) ? html`<div class="field-note">${body}</div>` : null;
  }

  private toggleNote(key: string): void {
    this.openNotes = this.openNotes.includes(key)
      ? this.openNotes.filter(item => item !== key)
      : [...this.openNotes, key];
  }

  /**
   * The key button that reveals the entry row for `key`. Its own colour carries the status that used
   * to need a permanently-visible "Configured" chip, so a keyed provider still reads at a glance.
   */
  private renderKeyToggle(key: string, configured: boolean, label: string) {
    const open = this.openKeys.includes(key);
    const title = `${label} — ${configured ? 'configured' : 'not set'}`;
    return html`<button
      type="button"
      class="key-toggle ${configured ? 'is-set' : ''} ${open ? 'is-open' : ''}"
      aria-expanded=${open}
      aria-label=${title}
      title=${title}
      @click=${() => this.toggleKey(key)}
    >
      ${this.icons.getIcon('key', IconSize.SMALL)}
    </button>`;
  }

  /** The key entry row for `key`, rendered only while its {@link renderKeyToggle} is on. */
  private renderKeyPanel(key: string, body: unknown) {
    return this.openKeys.includes(key) ? html`<div class="key-panel">${body}</div>` : null;
  }

  private toggleKey(key: string): void {
    this.openKeys = this.openKeys.includes(key)
      ? this.openKeys.filter(item => item !== key)
      : [...this.openKeys, key];
  }

  private renderSubtabs(subtabs: readonly SettingsSubtab[]) {
    return html`
      <div class="settings-subtabs" role="tablist">
        ${subtabs.map(
          tab => html`
            <button
              class="settings-subtab ${tab.id === this.activeSubtab ? 'is-active' : ''}"
              role="tab"
              aria-selected=${tab.id === this.activeSubtab}
              @click=${() => this.selectSubtab(tab.id)}
            >
              ${tab.label}
            </button>
          `
        )}
      </div>
    `;
  }

  private renderSectionContent(section: SettingsSectionDef) {
    switch (section.id) {
      case 'general':
        return this.renderGeneralTab();
      case 'images':
        return this.renderImagesGenerationTab();
      case 'about':
        return this.renderAboutTab();
    }
  }

  private renderAboutTab() {
    return html`
      <div class="settings-field">
        <div class="field-head">
          <span class="field-title">Version</span>
          <span class="resolved-tag">
            Pix3 Editor
            ${CURRENT_EDITOR_VERSION.displayVersion}${CURRENT_EDITOR_VERSION.publishedAt
              ? ` · published ${new Date(CURRENT_EDITOR_VERSION.publishedAt).toLocaleDateString()}`
              : ''}
          </span>
        </div>
        ${this.renderHostVersions()}
      </div>

      <div class="settings-field">
        <div class="about-links">
          ${PIX3_LINKS.map(
            link => html`
              <a class="about-link" href=${link.href} target="_blank" rel="noreferrer">
                <span class="about-link-icon">
                  ${this.icons.getIcon(link.icon, IconSize.MEDIUM)}
                </span>
                <span class="about-link-text">
                  <span class="about-link-label">${link.label}</span>
                  <span class="about-link-hint">${link.hint}</span>
                </span>
                <span class="about-link-external">
                  ${this.icons.getIcon('external-link', IconSize.SMALL)}
                </span>
              </a>
            `
          )}
        </div>
      </div>
    `;
  }

  /** First sub-tab id of a section, or '' when the section has none. */
  private defaultSubtab(sectionId: EditorSettingsTab): string {
    const section = SETTINGS_SECTIONS.find(s => s.id === sectionId);
    return section?.subtabs?.[0]?.id ?? '';
  }

  private selectSection(sectionId: EditorSettingsTab): void {
    this.activeSection = sectionId;
    this.activeSubtab = this.defaultSubtab(sectionId);
  }

  private selectSubtab(subtabId: string): void {
    this.activeSubtab = subtabId;
  }

  /** What the dev server reports it is running (`EditorHost.info.versions`). */
  private renderHostVersions() {
    if (!HostService.isInstalled()) {
      return null;
    }
    const { versions, projectName, root } = this.hostService.info;
    const rows: Array<[string, string | null]> = [
      ['Project', `${projectName} (${root})`],
      ['@pix3/vite-plugin', versions.plugin],
      ['@pix3/runtime', versions.runtime],
      ['@pix3/editor-core', versions.editorCore],
      ['Vite', versions.vite],
    ];
    return html`
      <dl class="about-versions">
        ${rows.map(
          ([label, value]) =>
            html`<dt>${label}</dt>
              <dd>${value ?? 'unknown'}</dd>`
        )}
      </dl>
    `;
  }

  private renderGeneralTab() {
    return html`
      <div class="settings-field">
        <div class="field-head">
          <label class="toggle-row">
            <input
              type="checkbox"
              .checked=${this.keepEditorRunningForAgent}
              @change=${this.onKeepAliveToggle}
            />
            <span>Keep the editor running while an agent is connected</span>
          </label>
          ${this.renderInfo('agent-keepalive')}
        </div>
        ${this.renderNote(
          'agent-keepalive',
          'While a coding agent drives this tab through DevTools (a debug-bridge call ran in the ' +
            'last five minutes), the game and the viewport keep running even when this tab is ' +
            'hidden or unfocused, so the agent never waits for a battery-saving pause. Without an ' +
            'agent the editor pauses in the background exactly as before.'
        )}
      </div>

      <div class="settings-field">
        <div class="field-head">
          <label class="toggle-row">
            <input
              type="checkbox"
              .checked=${this.pauseRenderingOnUnfocus}
              @change=${this.onPauseToggle}
            />
            <span>Pause rendering when window is unfocused</span>
          </label>
          ${this.renderInfo('pause-rendering')}
        </div>
        ${this.renderNote(
          'pause-rendering',
          'Reduces CPU/GPU usage and saves battery when you are working in another window.'
        )}
      </div>

      <div class="settings-section">
        <h3 class="section-title"><span>2D Navigation</span></h3>

        <div class="settings-field">
          <div class="field-head">
            <span class="field-title">
              Pan sensitivity: ${this.navigation2D.panSensitivity.toFixed(2)}
            </span>
            ${this.renderInfo('pan-sensitivity')}
          </div>
          ${this.renderNote(
            'pan-sensitivity',
            'Controls how fast the camera pans with mouse wheel or trackpad gestures.'
          )}
          <input
            type="range"
            aria-label="Pan sensitivity"
            min="0.1"
            max="1.0"
            step="0.05"
            .value=${String(this.navigation2D.panSensitivity)}
            @input=${this.onPanSensitivityChange}
          />
        </div>

        <div class="settings-field">
          <div class="field-head">
            <span class="field-title">
              Zoom sensitivity: ${this.navigation2D.zoomSensitivity.toFixed(4)}
            </span>
            ${this.renderInfo('zoom-sensitivity')}
          </div>
          ${this.renderNote(
            'zoom-sensitivity',
            'Controls how fast the camera zooms with Ctrl+wheel or pinch gestures.'
          )}
          <input
            type="range"
            aria-label="Zoom sensitivity"
            min="0.001"
            max="0.01"
            step="0.0005"
            .value=${String(this.navigation2D.zoomSensitivity)}
            @input=${this.onZoomSensitivityChange}
          />
        </div>
      </div>
    `;
  }

  private renderImagesGenerationTab() {
    const providers = this.imageProviders.list();
    if (providers.length === 0) {
      return html`<div class="field-note">No image providers are registered.</div>`;
    }
    const provider = this.imageProviders.get(this.aiProviderId) ?? providers[0];
    const models = provider?.models ?? [];
    const activeModel = provider?.getModel(this.aiModelId);
    const helpUrl = provider?.apiKeyHelpUrl;
    const ownsKey = provider?.requiresApiKey !== false;

    return html`
      <div class="settings-field">
        <div class="field-head">
          <span class="field-title">Provider &amp; model</span>
          ${this.renderInfo('image-model')}
        </div>
        ${this.renderNote(
          'image-model',
          activeModel?.description ?? 'Draws every generation of the Generate panel.'
        )}
        <div class="inline-row">
          <select class="inline-select" aria-label="Provider" @change=${this.onAiProviderChange}>
            ${providers.map(
              item =>
                html`<option value=${item.id} ?selected=${item.id === this.aiProviderId}>
                  ${item.label}
                </option>`
            )}
          </select>
          <select class="inline-select" aria-label="Model" @change=${this.onAiModelChange}>
            ${models.map(
              model =>
                html`<option value=${model.id} ?selected=${model.id === this.aiModelId}>
                  ${modelPickerLabel(model)}
                </option>`
            )}
          </select>
          ${ownsKey
            ? this.renderKeyToggle(
                'image',
                this.aiKeyConfigured,
                `${provider?.label ?? 'Provider'} API key`
              )
            : null}
        </div>
        ${ownsKey
          ? this.renderKeyPanel('image', this.renderImageKeyBody(helpUrl))
          : html`<div class="field-note">This provider needs no API key.</div>`}
      </div>

      <div class="settings-field">
        <div class="field-head">
          <span class="field-title">Default save size (downscale)</span>
          ${this.renderInfo('image-save-size')}
        </div>
        ${this.renderNote(
          'image-save-size',
          'Downscales the longest edge when saving a generated image into the project (never upscales). Game elements rarely need the full 1K/2K generation. Overridable per save in the Generate panel.'
        )}
        <select aria-label="Default save size" @change=${this.onDefaultSaveSizeChange}>
          <option value="0" ?selected=${this.defaultSaveMaxSize === 0}>Original size</option>
          <option value="1024" ?selected=${this.defaultSaveMaxSize === 1024}>≤ 1024 px</option>
          <option value="512" ?selected=${this.defaultSaveMaxSize === 512}>≤ 512 px</option>
          <option value="256" ?selected=${this.defaultSaveMaxSize === 256}>≤ 256 px</option>
          <option value="128" ?selected=${this.defaultSaveMaxSize === 128}>≤ 128 px</option>
          <option value="64" ?selected=${this.defaultSaveMaxSize === 64}>≤ 64 px</option>
        </select>
      </div>
    `;
  }

  /** API-key entry for an image provider that owns one (behind its key button). */
  private renderImageKeyBody(helpUrl: string | undefined) {
    return html`
      <div class="key-row">
        <input
          type="password"
          autocomplete="off"
          placeholder=${this.aiKeyConfigured ? '•••••••• stored' : 'Paste API key'}
          .value=${this.aiKeyInput}
          @input=${this.onAiKeyInput}
        />
        <button
          class="btn-key-save"
          @click=${this.onSaveAiKey}
          ?disabled=${!this.aiKeyInput.trim() || this.aiKeyBusy}
        >
          Save
        </button>
        ${this.aiKeyConfigured
          ? html`<button
              class="btn-key-clear"
              @click=${this.onClearAiKey}
              ?disabled=${this.aiKeyBusy}
            >
              Clear
            </button>`
          : null}
      </div>
      <div class="field-note">
        ${this.aiKeyMessage
          ? html`<span>${this.aiKeyMessage}</span>`
          : html`Paste your provider API
            key${helpUrl
              ? html` (get one from
                  <a href=${helpUrl} target="_blank" rel="noreferrer">the provider console</a>)`
              : ''}.
            Stored encrypted in this browser, per project — never synced, and only sent to the
            selected provider (OpenAI goes through the dev server's proxy).`}
      </div>
    `;
  }

  private onDefaultSaveSizeChange(e: Event): void {
    this.defaultSaveMaxSize = Number((e.target as HTMLSelectElement).value) || 0;
    this.aiImageSettings.updatePreferences({ defaultSaveMaxSize: this.defaultSaveMaxSize });
  }

  private async refreshAiKeyStatus(): Promise<void> {
    const provider = this.imageProviders.get(this.aiProviderId);
    if (!provider) {
      this.aiKeyConfigured = false;
      return;
    }
    try {
      this.aiKeyConfigured =
        provider.requiresApiKey === false
          ? ((await provider.isAvailable?.()) ?? true)
          : await this.aiImageSettings.hasApiKey(this.aiProviderId);
    } catch {
      this.aiKeyConfigured = false;
    }
  }

  private onAiProviderChange(e: Event): void {
    const providerId = (e.target as HTMLSelectElement).value;
    this.aiProviderId = providerId;
    this.aiImageSettings.updatePreferences({ selectedProviderId: providerId });
    this.aiModelId = this.aiImageSettings.getSelectedModelId(providerId) ?? '';
    this.aiKeyInput = '';
    this.aiKeyMessage = null;
    void this.refreshAiKeyStatus();
  }

  private onAiModelChange(e: Event): void {
    const modelId = (e.target as HTMLSelectElement).value;
    this.aiModelId = modelId;
    this.aiImageSettings.updatePreferences({ modelByProvider: { [this.aiProviderId]: modelId } });
  }

  private onAiKeyInput(e: Event): void {
    this.aiKeyInput = (e.target as HTMLInputElement).value;
    this.aiKeyMessage = null;
  }

  private async onSaveAiKey(): Promise<void> {
    const key = this.aiKeyInput.trim();
    if (!key || !this.aiProviderId) {
      return;
    }
    this.aiKeyBusy = true;
    try {
      await this.aiImageSettings.setApiKey(this.aiProviderId, key);
      this.aiKeyConfigured = true;
      this.aiKeyInput = '';
      this.aiKeyMessage = 'API key saved.';
    } catch (error) {
      this.aiKeyMessage = `Failed to save key: ${error instanceof Error ? error.message : 'unknown error'}`;
    } finally {
      this.aiKeyBusy = false;
    }
  }

  private async onClearAiKey(): Promise<void> {
    if (!this.aiProviderId) {
      return;
    }
    this.aiKeyBusy = true;
    try {
      await this.aiImageSettings.clearApiKey(this.aiProviderId);
      this.aiKeyConfigured = false;
      this.aiKeyInput = '';
      this.aiKeyMessage = 'API key removed.';
    } catch (error) {
      this.aiKeyMessage = `Failed to remove key: ${error instanceof Error ? error.message : 'unknown error'}`;
    } finally {
      this.aiKeyBusy = false;
    }
  }

  private onKeepAliveToggle(e: Event): void {
    const target = e.target as HTMLInputElement;
    this.keepEditorRunningForAgent = target.checked;
  }

  private onPauseToggle(e: Event): void {
    const target = e.target as HTMLInputElement;
    this.pauseRenderingOnUnfocus = target.checked;
  }

  private onPanSensitivityChange(e: Event): void {
    const target = e.target as HTMLInputElement;
    this.navigation2D.panSensitivity = parseFloat(target.value);
  }

  private onZoomSensitivityChange(e: Event): void {
    const target = e.target as HTMLInputElement;
    this.navigation2D.zoomSensitivity = parseFloat(target.value);
  }

  private onCancel(): void {
    this.editorSettingsService.close();
  }

  private async onSave(): Promise<void> {
    const operation = new UpdateEditorSettingsOperation({
      pauseRenderingOnUnfocus: this.pauseRenderingOnUnfocus,
      keepEditorRunningForAgent: this.keepEditorRunningForAgent,
      navigation2D: this.navigation2D,
    });

    await this.operationService.invoke(operation);
    this.editorSettingsService.close();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-editor-settings-dialog': EditorSettingsDialog;
  }
}
