import { Component } from '@angular/core';
import { LayoutComponent } from '@org/ui';

@Component({
  imports: [LayoutComponent],
  selector: 'app-root',
  template: `<ui-layout></ui-layout>`,
  styles: [
    `
      :host {
        display: block;
        height: 100vh;
      }
    `,
  ],
})
export class App {}
