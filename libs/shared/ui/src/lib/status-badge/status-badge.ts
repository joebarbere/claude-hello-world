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
        background: rgba(59, 130, 246, 0.15);
        color: #60a5fa;
      }
      .status-success {
        background: rgba(34, 197, 94, 0.15);
        color: #4ade80;
      }
      .status-warning {
        background: rgba(245, 158, 11, 0.15);
        color: #fbbf24;
      }
      .status-danger {
        background: rgba(239, 68, 68, 0.15);
        color: #f87171;
      }
      .status-neutral {
        background: rgba(148, 163, 184, 0.15);
        color: var(--text-secondary);
      }
      .status-cold {
        background: rgba(59, 130, 246, 0.15);
        color: #60a5fa;
      }
      .status-cool {
        background: rgba(6, 182, 212, 0.15);
        color: #22d3ee;
      }
      .status-mild {
        background: rgba(34, 197, 94, 0.15);
        color: #4ade80;
      }
      .status-warm {
        background: rgba(245, 158, 11, 0.15);
        color: #fbbf24;
      }
      .status-hot {
        background: rgba(239, 68, 68, 0.15);
        color: #f87171;
      }
    `,
  ],
})
export class StatusBadgeComponent {
  variant = input<string>('neutral');
}
