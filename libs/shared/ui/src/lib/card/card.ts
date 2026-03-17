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
        background: #ffffff;
        border: 1px solid #e9ecef;
        border-radius: 12px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
        overflow: hidden;
      }
    `,
  ],
})
export class CardComponent {}
