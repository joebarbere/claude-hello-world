import { Component, input } from '@angular/core';

@Component({
  selector: 'ui-status-badge',
  standalone: true,
  template: `
    <span class="status-badge" [class]="'status-badge status-' + variant()">
      <ng-content></ng-content>
    </span>
  `,
  styles: [
    `
      .status-badge {
        display: inline-block;
        padding: 2px 10px;
        border-radius: 9999px;
        font-size: 0.75rem;
        font-weight: 500;
        letter-spacing: 0.01em;
        white-space: nowrap;
      }
      .status-info {
        background: #eff6ff;
        color: #1d4ed8;
      }
      .status-success {
        background: #f0fdf4;
        color: #15803d;
      }
      .status-warning {
        background: #fffbeb;
        color: #b45309;
      }
      .status-danger {
        background: #fff1f2;
        color: #be123c;
      }
      .status-neutral {
        background: #f1f5f9;
        color: #475569;
      }
      .status-cold {
        background: #eff6ff;
        color: #1d4ed8;
      }
      .status-cool {
        background: #f0f9ff;
        color: #0369a1;
      }
      .status-mild {
        background: #f0fdf4;
        color: #15803d;
      }
      .status-warm {
        background: #fffbeb;
        color: #b45309;
      }
      .status-hot {
        background: #fff1f2;
        color: #be123c;
      }
    `,
  ],
})
export class StatusBadgeComponent {
  variant = input<string>('neutral');
}
