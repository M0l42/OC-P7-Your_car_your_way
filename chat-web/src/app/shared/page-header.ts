import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { I18n } from '../core/i18n';

@Component({
  selector: 'app-page-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page-header">
      <div class="title-row">
        <h1>{{ title() }}</h1>
        <button type="button" class="link" (click)="i18n.toggle()" [attr.lang]="i18n.lang() === 'fr' ? 'en' : 'fr'" [attr.aria-label]="i18n.t.languageSwitch">
          {{ i18n.t.language }}
        </button>
      </div>
      <p class="app-name">{{ i18n.t.appTitle }}</p>
      <ng-content />
    </header>
  `,
  styles: `
    .page-header {
      border-bottom: 1px solid var(--border);
      padding: 0.75rem 1rem;
      display: grid;
      gap: 0.35rem;
    }
    .title-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 1rem;
    }
    h1 {
      margin: 0;
      font-size: 1.5rem;
    }
    .app-name {
      margin: 0;
      color: var(--muted);
      font-size: 0.9rem;
    }
  `,
})
export class PageHeader {
  protected readonly i18n = inject(I18n);
  readonly title = input.required<string>();
}
