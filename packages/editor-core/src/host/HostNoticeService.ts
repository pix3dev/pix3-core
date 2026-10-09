import { injectable } from '@/fw/di';
import { LoggingService } from '@/services/core/LoggingService';
import { ServiceContainer } from '@/fw/di';
import { appState, type HostNotice } from '@/state';

export interface NoticeAction {
  readonly label: string;
  /** Runs on click; the notice is dismissed first. */
  readonly run: () => void | Promise<void>;
}

export interface NoticeInput {
  readonly tone?: HostNotice['tone'];
  readonly message: string;
  readonly detail?: string;
  readonly actions?: readonly NoticeAction[];
  /** Replace an earlier notice with the same key (one per scene and kind). */
  readonly key?: string;
}

/**
 * The write model's notices ("тост" in plan §C.3/§C.1): merge results with the keys that were
 * dropped, "the agent overwrote your edit [Restore]", a draft to restore. Session UI state owned
 * by this service (AGENTS.md "Gateway scope"); `pix3-host-banner` renders it and calls
 * {@link runAction}. Every notice is also written to the log, so the agent and the Logs panel see it.
 */
@injectable()
export class HostNoticeService {
  private readonly actions = new Map<string, NoticeAction>();
  private nextId = 0;

  show(input: NoticeInput): string {
    const id = input.key ?? `notice-${++this.nextId}`;
    this.dismiss(id);
    const actions = (input.actions ?? []).map((action, index) => {
      const actionId = `${id}#${index}`;
      this.actions.set(actionId, action);
      return { id: actionId, label: action.label };
    });
    const notice: HostNotice = {
      id,
      tone: input.tone ?? 'info',
      message: input.message,
      ...(input.detail ? { detail: input.detail } : {}),
      actions,
    };
    appState.project.host.notices = [...appState.project.host.notices, notice];
    const logger = this.logger();
    const line = input.detail ? `${input.message} ${input.detail}` : input.message;
    if (input.tone === 'warn') logger?.warn(line);
    else logger?.info(line);
    return id;
  }

  dismiss(id: string): void {
    for (const key of [...this.actions.keys()])
      if (key.startsWith(`${id}#`)) this.actions.delete(key);
    if (appState.project.host.notices.some(notice => notice.id === id)) {
      appState.project.host.notices = appState.project.host.notices.filter(n => n.id !== id);
    }
  }

  async runAction(actionId: string): Promise<void> {
    const action = this.actions.get(actionId);
    this.dismiss(actionId.slice(0, actionId.lastIndexOf('#')));
    await action?.run();
  }

  reset(): void {
    this.actions.clear();
    appState.project.host.notices = [];
  }

  private logger(): LoggingService | null {
    const container = ServiceContainer.getInstance();
    const token = container.getOrCreateToken(LoggingService);
    return container.hasService(token) ? container.getService<LoggingService>(token) : null;
  }
}
