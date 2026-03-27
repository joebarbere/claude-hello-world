import { Component } from '@angular/core';

@Component({
  selector: 'ui-card',
  standalone: true,
  template: `
    <div class="ui-card">
      <ng-content></ng-content>
    </div>
  `,
  styles: [
    `
      .ui-card {
        background: var(--bg-surface);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        box-shadow: var(--shadow-sm);
        overflow: hidden;
      }
    `,
  ],
})
export class CardComponent {}
