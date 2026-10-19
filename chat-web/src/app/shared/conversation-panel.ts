import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { ChatSession } from '../core/chat-session';
import { I18n } from '../core/i18n';
import { ApiError, MAX_CONTENT_LENGTH, codePointLength, deriveStatus, type Conversation, type EchoStatus, type StreamItem } from '../core/reliability';

interface Entry {
  key: string;
  kind: 'message' | 'event';
  who: string;
  text: string;
  time: string;
  own: boolean;
  echo?: EchoStatus;
  echoReason?: string;
  clientMessageId: string;
}

/**
 * One conversation: header with derived status, message log (role=log, aria-live polite, switched
 * off while a backfilled batch is inserted — C4), composer and close action. Used by both views.
 */
@Component({
  selector: 'app-conversation-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel" [attr.aria-labelledby]="headingId()">
      <header class="panel-header">
        <h2 [id]="headingId()" tabindex="-1" #heading>{{ i18n.t.conversationTitle(conversation().id) }}</h2>
        <p class="status" data-testid="conversation-status">
          {{ i18n.t.statusLabel }} : <strong>{{ statusText() }}</strong>
          @if (conversation().reservationReference; as ref) {
            · <span>{{ ref }}</span>
          }
        </p>
      </header>

      <div
        class="log"
        role="log"
        [attr.aria-live]="session.backfilling() ? 'off' : 'polite'"
        aria-relevant="additions"
        [attr.aria-label]="i18n.t.messagesLabel"
        tabindex="0"
        data-testid="message-log"
        #log
      >
        @if (entries().length === 0) {
          <p class="empty">{{ i18n.t.noMessages }}</p>
        }
        <ol>
          @for (e of entries(); track e.key) {
            <li [class]="e.kind" [class.own]="e.own" [attr.data-echo]="e.echo ?? null" data-testid="message">
              @if (e.kind === 'event') {
                <span class="event-text">{{ e.text }}</span>
              } @else {
                <span class="who">{{ e.who }}</span><span class="visually-hidden"> : </span>
                <span class="text">{{ e.text }}</span>
              }
              <span class="meta">
                @if (e.time) {
                  <time>{{ e.time }}</time>
                }
                @if (e.echo) {
                  <span class="echo" data-testid="echo-status">
                    {{ echoText(e.echo) }}@if (e.echoReason) {
                      ({{ e.echoReason }})
                    }
                  </span>
                  @if (e.echo === 'failed') {
                    <button type="button" class="link" (click)="dismiss(e.clientMessageId)">{{ i18n.t.dismiss }}</button>
                  }
                }
              </span>
            </li>
          }
        </ol>
      </div>

      @if (status() === 'cloturee') {
        <p class="closed-notice" data-testid="closed-notice">{{ i18n.t.closedNotice }}</p>
      } @else {
        <form class="composer" (submit)="submit($event)" novalidate>
          <label [for]="inputId()">{{ i18n.t.composerLabel }}</label>
          <textarea
            [id]="inputId()"
            #input
            rows="3"
            [attr.aria-describedby]="inputId() + '-hint ' + inputId() + '-count' + (error() ? ' ' + inputId() + '-error' : '')"
            [attr.aria-invalid]="error() ? 'true' : null"
            [value]="draft()"
            (input)="onInput($event)"
            (keydown.enter)="onEnter($event)"
            data-testid="composer"
          ></textarea>
          <p class="hint" [id]="inputId() + '-hint'">{{ i18n.t.composerHint(max) }}</p>
          <p class="count" [id]="inputId() + '-count'" [class.over]="length() > max">{{ i18n.t.charCount(length(), max) }}</p>
          @if (error(); as err) {
            <p class="error" [id]="inputId() + '-error'" data-testid="composer-error">{{ err }}</p>
          }
          <div class="actions">
            <button type="submit" data-testid="send">{{ i18n.t.send }}</button>
            <button type="button" class="secondary" (click)="closeConversation()" [disabled]="closing()" data-testid="close">
              {{ closing() ? i18n.t.closing : i18n.t.close }}
            </button>
          </div>
          @if (closeError(); as ce) {
            <p class="error" role="alert">{{ ce }}</p>
          }
        </form>
      }
    </section>
  `,
  styleUrl: './conversation-panel.css',
})
export class ConversationPanel {
  protected readonly session = inject(ChatSession);
  protected readonly i18n = inject(I18n);

  readonly conversation = input.required<Conversation>();
  /** Which side we are: decides "Vous" vs "Client"/"Conseiller". */
  readonly side = input.required<'customer' | 'agent'>();

  protected readonly max = MAX_CONTENT_LENGTH;
  protected readonly draft = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly closing = signal(false);
  protected readonly closeError = signal<string | null>(null);

  private readonly log = viewChild<ElementRef<HTMLElement>>('log');
  private readonly inputEl = viewChild<ElementRef<HTMLTextAreaElement>>('input');

  protected readonly headingId = computed(() => `conv-${this.conversation().id}-title`);
  protected readonly inputId = computed(() => `conv-${this.conversation().id}-input`);
  protected readonly length = computed(() => codePointLength(this.draft().trim()));

  protected readonly items = computed(() => this.session.items(this.conversation().id));
  readonly status = computed(() => deriveStatus(this.conversation().status, this.items()));
  protected readonly statusText = computed(() => this.i18n.t[`status_${this.status()}`]);

  protected readonly entries = computed<Entry[]>(() => {
    const id = this.conversation().id;
    const fromStream = this.items().map((i) => this.toEntry(i));
    const echoes = this.session.echoes(id).map<Entry>((e) => ({
      key: e.clientMessageId,
      kind: 'message',
      who: this.i18n.t.you,
      text: e.content,
      time: '',
      own: true,
      echo: e.status,
      echoReason: e.status === 'failed' ? this.i18n.reason(e.errorCode) : undefined,
      clientMessageId: e.clientMessageId,
    }));
    return [...fromStream, ...echoes];
  });

  constructor() {
    // Keep the newest message in view (instant scroll: nothing animated, reduced-motion friendly).
    afterRenderEffect(() => {
      this.entries();
      const el = this.log()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  protected echoText(s: EchoStatus): string {
    return s === 'sending' ? this.i18n.t.echo_sending : s === 'sent' ? this.i18n.t.echo_sent : this.i18n.t.echo_failed;
  }

  protected onInput(e: Event): void {
    this.draft.set((e.target as HTMLTextAreaElement).value);
    if (this.error()) this.error.set(null);
  }

  protected onEnter(e: Event): void {
    const k = e as KeyboardEvent;
    if (k.shiftKey || k.isComposing) return;
    k.preventDefault();
    this.send();
  }

  protected submit(e: Event): void {
    e.preventDefault();
    this.send();
  }

  protected dismiss(clientMessageId: string): void {
    this.session.dismissFailed(this.conversation().id, clientMessageId);
  }

  protected async closeConversation(): Promise<void> {
    const id = this.conversation().id;
    this.closing.set(true);
    this.closeError.set(null);
    try {
      await this.session.api.close(id);
    } catch (e) {
      // 409 CONVERSATION_CLOSED means it is already closed: the backfill below shows the event.
      if (!(e instanceof ApiError && e.code === 'CONVERSATION_CLOSED')) {
        this.closeError.set(this.i18n.t.closeFailed(this.i18n.reason(e instanceof ApiError ? e.code : undefined)));
      }
    } finally {
      this.closing.set(false);
      this.session.backfill(id);
    }
  }

  private send(): void {
    const r = this.session.send(this.conversation().id, this.draft());
    if (!r.ok) {
      this.error.set(r.code === 'EMPTY' ? this.i18n.t.emptyMessage : this.i18n.t.tooLong(this.max));
      this.inputEl()?.nativeElement.focus();
      return;
    }
    this.draft.set('');
    this.error.set(null);
    const el = this.inputEl()?.nativeElement;
    if (el) {
      el.value = '';
      el.focus();
    }
  }

  private toEntry(i: StreamItem): Entry {
    const t = this.i18n.t;
    const time = formatTime(i.createdAt, this.i18n.lang());
    if (i.type !== 'texte') {
      const c = this.conversation();
      const closer = i.senderRef === c.customerRef ? t.customer : t.agent;
      const own = i.senderRef === this.session.subject;
      return {
        key: i.clientMessageId,
        kind: 'event',
        who: t.system,
        text: i.type === 'prise_en_charge' ? t.eventClaimed : t.eventClosedBy(own ? t.you.toLowerCase() : closer.toLowerCase()),
        time,
        own: false,
        clientMessageId: i.clientMessageId,
      };
    }
    const own = (this.side() === 'customer' ? i.senderRole === 'client' : i.senderRole === 'agent') && i.senderRef === this.session.subject;
    return {
      key: i.clientMessageId,
      kind: 'message',
      who: own ? t.you : i.senderRole === 'client' ? t.customer : t.agent,
      text: i.content ?? '',
      time,
      own,
      clientMessageId: i.clientMessageId,
    };
  }
}

function formatTime(iso: string, lang: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(lang === 'en' ? 'en-GB' : 'fr-FR', { hour: '2-digit', minute: '2-digit' });
}
