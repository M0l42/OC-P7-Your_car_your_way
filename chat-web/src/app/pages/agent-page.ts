import { ChangeDetectionStrategy, Component, ElementRef, Injector, OnInit, afterNextRender, computed, inject, signal } from '@angular/core';
import { ChatSession } from '../core/chat-session';
import { I18n } from '../core/i18n';
import { ApiError, deriveStatus, type Conversation } from '../core/reliability';
import { ConnectionStatus } from '../shared/connection-status';
import { ConversationPanel } from '../shared/conversation-panel';
import { PageHeader } from '../shared/page-header';

/** Agent view `/agent` (demo: `/agent?node=b`): queue (oldest 50 + total), claim, converse, close. */
@Component({
  selector: 'app-agent-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConnectionStatus, ConversationPanel, PageHeader],
  providers: [ChatSession],
  template: `
    <app-page-header [title]="i18n.t.agentHeading">
      <app-connection-status />
    </app-page-header>
    <main class="agent-layout" id="main">
      <div class="sidebar">
        <section aria-labelledby="queue-title" data-testid="queue">
          <h2 id="queue-title">{{ i18n.t.queueHeading }}</h2>
          <p class="count" data-testid="queue-count">{{ i18n.t.queueCount(queue().items.length, queue().total) }}</p>
          @if (queue().items.length) {
            <ul class="queue">
              @for (c of queue().items; track c.id) {
                <li data-testid="queue-item">
                  <span>{{ i18n.t.queueItem(c.id, c.reservationReference) }}</span>
                  <span class="since">{{ i18n.t.waitingSince }} {{ time(c.createdAt) }}</span>
                  <button type="button" (click)="claim(c)" [disabled]="claiming() === c.id" [attr.aria-label]="i18n.t.claimNamed(c.id)">
                    {{ i18n.t.claim }}
                  </button>
                </li>
              }
            </ul>
          }
        </section>

        <nav aria-labelledby="mine-title" data-testid="mine">
          <h2 id="mine-title">{{ i18n.t.myConversations }}</h2>
          @if (mine().length) {
            <ul class="mine">
              @for (c of mine(); track c.id) {
                <li>
                  <button
                    type="button"
                    class="secondary"
                    [attr.aria-current]="c.id === selectedId() ? 'true' : null"
                    (click)="select(c.id)"
                    data-testid="mine-item"
                  >
                    {{ i18n.t.conversationTitle(c.id) }} — {{ statusText(c) }}
                  </button>
                </li>
              }
            </ul>
          } @else {
            <p class="muted">{{ i18n.t.noMyConversations }}</p>
          }
        </nav>
      </div>

      <div class="conversation">
        @if (selected(); as c) {
          <app-conversation-panel [conversation]="c" side="agent" />
        } @else {
          <p class="muted">{{ i18n.t.selectConversation }}</p>
        }
      </div>
    </main>
  `,
  styleUrl: './agent-page.css',
})
export class AgentPage implements OnInit {
  protected readonly i18n = inject(I18n);
  private readonly session = inject(ChatSession);
  private readonly injector = inject(Injector);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  protected readonly queue = this.session.queue;
  protected readonly mine = signal<Conversation[]>([]);
  protected readonly selectedId = signal<number | null>(null);
  protected readonly claiming = signal<number | null>(null);
  protected readonly selected = computed(() => this.mine().find((c) => c.id === this.selectedId()) ?? null);

  async ngOnInit(): Promise<void> {
    await this.session.start('agent');
    this.session.watchQueue();
    try {
      // Conversations this agent already holds (en_cours), e.g. after a reload.
      const page = await this.session.api.myConversations();
      for (const c of page.items) this.adopt(c);
      if (page.items.length) this.selectedId.set(page.items[0].id);
    } catch (e) {
      console.warn('[chat] my conversations', e);
    }
  }

  protected statusText(c: Conversation): string {
    return this.i18n.t[`status_${deriveStatus(c.status, this.session.items(c.id))}`];
  }

  protected time(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(this.i18n.lang() === 'en' ? 'en-GB' : 'fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  protected select(id: number): void {
    this.selectedId.set(id);
    this.focusComposer();
  }

  protected async claim(c: Conversation): Promise<void> {
    if (this.claiming() !== null) return;
    this.claiming.set(c.id);
    try {
      const claimed = await this.session.api.claim(c.id);
      this.session.removeFromQueue(c.id);
      this.adopt(claimed);
      this.selectedId.set(claimed.id);
      this.session.announce(this.i18n.t.claimed(claimed.id));
      this.focusComposer();
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'ALREADY_CLAIMED' || e.status === 409 || e.status === 404)) {
        // Lost the race (or the customer closed it): it leaves our queue.
        this.session.removeFromQueue(c.id);
        this.session.announce(this.i18n.t.claimLost(c.id));
      } else {
        this.session.announce(this.i18n.reason(e instanceof ApiError ? e.code : undefined));
      }
      this.session.refetchQueue();
    } finally {
      this.claiming.set(null);
    }
  }

  private adopt(c: Conversation): void {
    if (!this.mine().some((m) => m.id === c.id)) this.mine.update((list) => [c, ...list]);
    this.session.watch(c.id);
  }

  private focusComposer(): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLTextAreaElement>('[data-testid="composer"]')?.focus(), {
      injector: this.injector,
    });
  }
}
