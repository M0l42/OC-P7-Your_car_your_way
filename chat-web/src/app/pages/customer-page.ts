import { ChangeDetectionStrategy, Component, ElementRef, OnInit, afterNextRender, computed, inject, Injector, signal } from '@angular/core';
import { ChatSession } from '../core/chat-session';
import { I18n } from '../core/i18n';
import { ApiError, deriveStatus, newUuid, type Conversation, type KeyValueStorage } from '../core/reliability';
import { ConnectionStatus } from '../shared/connection-status';
import { ConversationPanel } from '../shared/conversation-panel';
import { PageHeader } from '../shared/page-header';

const CONVERSATION_KEY = 'ycyw.chat.customer.conversation.v1';
const OPEN_REQUEST_KEY = 'ycyw.chat.customer.open-request.v1';

interface OpenRequest {
  clientRequestId: string;
  reservationReference: string;
}

/** Customer view `/` (demo: `/?node=a`): open a conversation, chat, close. */
@Component({
  selector: 'app-customer-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConnectionStatus, ConversationPanel, PageHeader],
  providers: [ChatSession],
  template: `
    <app-page-header [title]="i18n.t.customerHeading">
      <app-connection-status />
    </app-page-header>
    <main class="page" id="main">
      @if (conversation(); as c) {
        <app-conversation-panel [conversation]="c" side="customer" />
        @if (status() === 'cloturee') {
          <button type="button" class="new" (click)="newConversation()" data-testid="new-conversation">{{ i18n.t.newConversation }}</button>
        }
      } @else if (ready()) {
        <section aria-labelledby="open-title" class="open">
          <h2 id="open-title">{{ i18n.t.customerHeading }}</h2>
          <p>{{ i18n.t.openIntro }}</p>
          <form (submit)="open($event)" novalidate>
            <label for="reservation">{{ i18n.t.reservationLabel }}</label>
            <input
              id="reservation"
              name="reservation"
              type="text"
              autocomplete="off"
              maxlength="64"
              aria-describedby="reservation-hint"
              [value]="reservation()"
              (input)="reservation.set($any($event.target).value)"
              data-testid="reservation"
            />
            <p id="reservation-hint" class="hint">{{ i18n.t.reservationHint }}</p>
            <button type="submit" [disabled]="opening()" data-testid="open">
              {{ opening() ? i18n.t.opening : i18n.t.openButton }}
            </button>
            @if (openError()) {
              <p class="error" role="alert">{{ i18n.t.openFailed }}</p>
            }
          </form>
        </section>
      }
    </main>
  `,
  styleUrl: './pages.css',
})
export class CustomerPage implements OnInit {
  protected readonly i18n = inject(I18n);
  private readonly session = inject(ChatSession);
  private readonly injector = inject(Injector);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  protected readonly conversation = signal<Conversation | null>(null);
  protected readonly ready = signal(false);
  protected readonly opening = signal(false);
  protected readonly openError = signal(false);
  protected readonly reservation = signal('');

  protected readonly status = computed(() => {
    const c = this.conversation();
    return c ? deriveStatus(c.status, this.session.items(c.id)) : null;
  });

  private get storage(): KeyValueStorage | null {
    return this.session.storage;
  }

  async ngOnInit(): Promise<void> {
    await this.session.start('customer');
    const pending = this.readOpenRequest();
    if (pending) this.reservation.set(pending.reservationReference);
    const stored = Number(this.read(CONVERSATION_KEY));
    const restoredId = stored || this.session.outboxConversationIds()[0];
    if (restoredId) {
      try {
        this.show(await this.session.api.getConversation(restoredId), false);
      } catch {
        this.remove(CONVERSATION_KEY);
      }
    }
    this.ready.set(true);
  }

  protected async open(e: Event): Promise<void> {
    e.preventDefault();
    if (this.opening()) return;
    // A6: the same clientRequestId is reused for every retry of this "open" (also after a reload).
    const req = this.readOpenRequest() ?? { clientRequestId: newUuid(), reservationReference: this.reservation().trim() };
    req.reservationReference = this.reservation().trim();
    this.write(OPEN_REQUEST_KEY, JSON.stringify(req));
    this.opening.set(true);
    this.openError.set(false);
    try {
      const c = await this.session.api.openConversation(req.clientRequestId, req.reservationReference || null);
      this.remove(OPEN_REQUEST_KEY);
      this.show(c, true);
    } catch (err) {
      console.warn('[chat] open', err instanceof ApiError ? err.code : err);
      this.openError.set(true);
    } finally {
      this.opening.set(false);
    }
  }

  protected newConversation(): void {
    const c = this.conversation();
    if (c) this.session.unwatch(c.id);
    this.remove(CONVERSATION_KEY);
    this.reservation.set('');
    this.conversation.set(null);
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLInputElement>('#reservation')?.focus(), { injector: this.injector });
  }

  private show(c: Conversation, focusComposer: boolean): void {
    this.write(CONVERSATION_KEY, String(c.id));
    this.conversation.set(c);
    this.session.watch(c.id);
    if (focusComposer) {
      afterNextRender(() => this.host.nativeElement.querySelector<HTMLTextAreaElement>('[data-testid="composer"]')?.focus(), {
        injector: this.injector,
      });
    }
  }

  private readOpenRequest(): OpenRequest | null {
    try {
      const raw = this.read(OPEN_REQUEST_KEY);
      return raw ? (JSON.parse(raw) as OpenRequest) : null;
    } catch {
      return null;
    }
  }

  private read(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: string): void {
    try {
      this.storage?.setItem(key, value);
    } catch {
      // storage blocked: works for this page lifetime
    }
  }

  private remove(key: string): void {
    try {
      this.storage?.removeItem(key);
    } catch {
      // ignore
    }
  }
}
