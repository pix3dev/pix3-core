import { injectable, inject } from '@/fw/di';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { AddModelCommand } from '@/features/scene/AddModelCommand';
import { CreateSprite2DCommand } from '@/features/scene/CreateSprite2DCommand';
import { SceneManager } from '@pix3/runtime';
import type { SceneGraph } from '@pix3/runtime';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { IdeLauncherService } from '@/services/editor/IdeLauncherService';
import { LightboxService } from '@/services/editor/LightboxService';
import { HostService } from '@/host/HostService';

export interface AssetActivation {
  name: string;
  path: string;
  kind: FileSystemHandleKind;
  resourcePath: string | null;
  extension: string; // lowercase without dot
}

/**
 * AssetFileActivationService handles opening asset files from the project tree.
 * It dispatches appropriate commands based on file type (e.g., LoadSceneCommand for .pix3scene files).
 */
export class AssetFileActivationService {
  /** Image formats a double-click previews full-screen. */
  static readonly SUPPORTED_IMAGE_EXTENSIONS = new Set([
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'bmp',
    'svg',
    'tif',
    'tiff',
    'avif',
  ]);
  /**
   * Text files that open in the developer's IDE (2.x has no in-browser code editor). `pix3anim` is
   * here too: its 1.x editor was the dropped Sprite Editor, and the file is plain YAML.
   */
  static readonly IDE_EXTENSIONS = new Set([
    'ts',
    'tsx',
    'js',
    'jsx',
    'mjs',
    'cjs',
    'json',
    'md',
    'txt',
    'yaml',
    'yml',
    'html',
    'css',
    'glsl',
    'frag',
    'vert',
    'pix3anim',
  ]);
  private static readonly UI_LAYER_NAME = 'UI Layer';

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(EditorTabService)
  private readonly editorTabService!: EditorTabService;

  @inject(IdeLauncherService)
  private readonly ideLauncher!: IdeLauncherService;

  @inject(LightboxService)
  private readonly lightbox!: LightboxService;

  @inject(HostService)
  private readonly hostService!: HostService;

  /**
   * Handle activation of an asset file from the project tree.
   * @param payload File activation details including extension and resource path
   */
  async handleActivation(payload: AssetActivation): Promise<void> {
    const { extension, resourcePath, name } = payload;
    if (!resourcePath) return;

    if (AssetFileActivationService.SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
      await this.handleImageAsset(payload);
      return;
    }

    if (extension === 'pix3scene') {
      await this.editorTabService.focusOrOpenScene(resourcePath);
      return;
    }

    if (extension === 'glb' || extension === 'gltf') {
      const command = new AddModelCommand({ modelPath: resourcePath, modelName: name });
      await this.commandDispatcher.execute(command);
      return;
    }

    // Scripts, JSON, markdown, config, … open in the IDE through the dev server.
    if (AssetFileActivationService.IDE_EXTENSIONS.has(extension)) {
      if (!(await this.ideLauncher.open(resourcePath))) {
        console.info('[AssetFileActivationService] No IDE hook on this host for', resourcePath);
      }
      return;
    }

    console.info('[AssetFileActivationService] No handler for asset type', payload);
  }

  /**
   * Double-clicking an image asset previews it full-screen (the 1.x Sprite Editor is not part of
   * 2.x). Creating a Sprite2D node from an image is an explicit action instead — drag the asset into
   * the viewport/tree, or the asset context menu's "Add to Scene as Sprite2D" (see
   * {@link createSpriteFromImage}).
   */
  private async handleImageAsset(payload: AssetActivation): Promise<void> {
    if (!payload.resourcePath || !HostService.isInstalled()) {
      return;
    }
    const url = this.hostService.host.files.url(this.hostService.wirePath(payload.resourcePath));
    this.lightbox.open([{ kind: 'image', title: payload.name, url, path: payload.path }]);
  }

  /**
   * Create a Sprite2D node in the active scene from an image asset. This is the explicit
   * (context-menu / drag) path — it is deliberately no longer the double-click default.
   */
  async createSpriteFromImage(payload: AssetActivation): Promise<void> {
    const sceneGraph = this.sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      console.warn(
        '[AssetFileActivationService] Cannot create sprite without an active scene',
        payload
      );
      return;
    }

    const uiLayer = this.findUiLayer(sceneGraph);
    if (!uiLayer) {
      console.info(
        '[AssetFileActivationService] UI layer missing, sprite will be added to root',
        payload
      );
    }

    const command = new CreateSprite2DCommand({
      spriteName: this.deriveSpriteName(payload.name),
      texturePath: payload.resourcePath,
      parentNodeId: uiLayer?.nodeId ?? null,
    });

    await this.commandDispatcher.execute(command);
  }

  private findUiLayer(sceneGraph: SceneGraph) {
    return sceneGraph.rootNodes.find(
      node => node.type === 'Group2D' && node.name === AssetFileActivationService.UI_LAYER_NAME
    );
  }

  private deriveSpriteName(fileName: string): string {
    const stripped = fileName.replace(/\.[^./]+$/, '').trim();
    return stripped || 'Sprite2D';
  }
}

injectable()(AssetFileActivationService);
