import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ChatSession } from '../core/chat-session';
import { I18n } from '../core/i18n';

/**
 * Connection indicator + mandatory instance badge (C5) + the status live region (role=status),
 * kept separate from the message log so recovery summaries never mix with message announcements.
 */
@Component({
  selector: 'app-connection-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="connection" [attr.data-state]="session.state()">
      <span class="dot" aria-hidden="true"></span>
      <span class="state" data-testid="connection-state">{{ stateText() }}</span>
      <span class="badge" data-testid="instance-badge">
        {{ i18n.t.instance }} : <strong>{{ session.instanceId() ?? i18n.t.instanceUnknown }}</strong>
      </span>
    </div>
    <p class="visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-testid="status-region">
      {{ session.announcement() }}
    </p>
  `,
  styles: `
    .connection {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 1rem;
      font-size: 0.9rem;
    }
    .dot {
      width: 0.75rem;
      height: 0.75rem;
      border-radius: 50%;
      background: var(--warn);
      border: 1px solid var(--fg);
    }
    [data-state='ready'] .dot {
      background: var(--ok);
    }
    [data-state='waiting'] .dot,
    [data-state='stopped'] .dot {
      background: var(--err);
    }
    .badge {
      padding: 0.1rem 0.5rem;
      border: 1px solid var(--border);
      border-radius: 1rem;
      font-family: ui-monospace, monospace;
    }
  `,
})
export class ConnectionStatus {
  protected readonly session = inject(ChatSession);
  protected readonly i18n = inject(I18n);

  protected readonly stateText = computed(() => {
    const t = this.i18n.t;
    switch (this.session.state()) {
      case 'idle':
        return t.stateIdle;
      case 'connecting':
        return t.stateConnecting;
      case 'subscribing':
        return t.stateSubscribing;
      case 'ready':
        return t.stateReady;
      case 'waiting':
        return t.stateWaiting;
      case 'renewing':
        return t.stateRenewing;
      default:
        return t.stateStopped;
    }
  });
}
