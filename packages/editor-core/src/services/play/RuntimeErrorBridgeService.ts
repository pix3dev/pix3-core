import { injectable, inject } from '@/fw/di';
import {
  isTestHarnessComponentType,
  registerScriptErrorSink,
  registerSignalEmitSink,
  type ScriptErrorInfo,
  type SignalEmitInfo,
} from '@pix3/runtime';
import { LoggingService } from '@/services/core/LoggingService';

/**
 * RuntimeErrorBridgeService
 *
 * Bridges runtime failures in the editor's own page (a script's editor preview, a scene load)
 * into the Logs panel:
 *  - Script/lifecycle errors caught by the runtime are delivered through
 *    `registerScriptErrorSink` and forwarded via {@link LoggingService}.
 *  - Truly-uncaught `error` / `unhandledrejection` events are mirrored too, so a failure that
 *    escapes every guard shows up in the editor instead of only in the browser devtools console.
 *  - Every `NodeBase.emit` is logged at `debug` ({@link handleSignalEmit}).
 *
 * The game itself runs on its own page (plan play-in-page); its errors reach the Logs panel over
 * `PlayPageLink`.
 */
@injectable()
export class RuntimeErrorBridgeService {
  @inject(LoggingService)
  private readonly loggingService!: LoggingService;

  private initialized = false;
  private disposeSink?: () => void;
  private disposeSignalSink?: () => void;

  initialize(): void {
    if (this.initialized || typeof window === 'undefined') {
      return;
    }
    this.initialized = true;

    this.disposeSink = registerScriptErrorSink(this.handleScriptError);
    this.disposeSignalSink = registerSignalEmitSink(this.handleSignalEmit);
    window.addEventListener('error', this.handleWindowError);
    window.addEventListener('unhandledrejection', this.handleUnhandledRejection);
  }

  private readonly handleScriptError = (error: ScriptErrorInfo): void => {
    const where = error.nodeName
      ? ` in "${error.nodeName}"${error.componentType ? ` (${error.componentType})` : ''}`
      : '';
    const detail = {
      phase: error.phase,
      nodeName: error.nodeName,
      componentType: error.componentType,
      componentId: error.componentId,
      stack: error.stack,
    };

    // A `test:`-prefixed component is the harness, not the game (see
    // `isTestHarnessComponentType`), and the difference decides two things.
    //
    // It is logged as a WARNING rather than an error, which keeps it visible in the
    // Logs panel and in devtools while keeping it OUT of the captured-error ring —
    // `installErrorCapture` patches `console.error` only. That ring is what the
    // gameplay harness counts for `newErrors`, and a run may have `newErrors` as its
    // crash net, checked BEFORE the bot's own verdict: reported as an error, a broken
    // test policy would end the run as "the GAME threw" on the frame it died.
    if (isTestHarnessComponentType(error.componentType)) {
      this.loggingService.warn(`Test harness error [${error.phase}]${where}: ${error.message}`, {
        ...detail,
        note: 'This is test-harness code failing, not the game. It is deliberately not counted as a runtime error.',
      });
      return;
    }

    this.loggingService.error(`Script error [${error.phase}]${where}: ${error.message}`, detail);
  };

  /**
   * A signal fired. Logged at `debug` so a chatty game does not drown the panel's default view,
   * and with the listener count because the failure this makes visible is usually "the signal fires
   * and nobody is listening".
   */
  private readonly handleSignalEmit = (info: SignalEmitInfo): void => {
    const target = info.nodeName || info.nodeId;
    this.loggingService.logFrom(
      'game',
      'debug',
      `Signal "${info.signal}" from ${target} → ${info.listenerCount} listener(s)`,
      info.args.length > 0 ? { args: info.args } : undefined
    );
  };

  private readonly handleWindowError = (event: ErrorEvent): void => {
    // Ignore resource-load errors (img/script/link) — they have no message and
    // no Error object, and would only add noise to the Logs panel.
    if (!event.message && !(event.error instanceof Error)) {
      return;
    }
    const stack = event.error instanceof Error ? event.error.stack : undefined;
    this.loggingService.error(`Uncaught error: ${event.message || 'unknown error'}`, {
      file: event.filename || undefined,
      line: event.lineno || undefined,
      column: event.colno || undefined,
      stack,
    });
  };

  private readonly handleUnhandledRejection = (event: PromiseRejectionEvent): void => {
    const reason = event.reason;
    const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    this.loggingService.error(`Unhandled promise rejection: ${message}`, {
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  };

  dispose(): void {
    this.disposeSink?.();
    this.disposeSink = undefined;
    this.disposeSignalSink?.();
    this.disposeSignalSink = undefined;
    if (typeof window !== 'undefined') {
      window.removeEventListener('error', this.handleWindowError);
      window.removeEventListener('unhandledrejection', this.handleUnhandledRejection);
    }
    this.initialized = false;
  }
}
