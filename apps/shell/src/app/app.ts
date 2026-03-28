import { Component, inject, signal, OnInit } from '@angular/core';
import { LayoutComponent, NavSession } from '@org/ui';
import { AuthService } from './auth/auth.service';

@Component({
  imports: [LayoutComponent],
  selector: 'app-root',
  template: `<ui-layout [session]="session()" (logoutRequest)="onLogout()"></ui-layout>`,
  styles: [
    `
      :host {
        display: block;
        height: 100vh;
      }
    `,
  ],
})
export class App implements OnInit {
  private readonly auth = inject(AuthService);
  session = signal<NavSession | null>(null);

  ngOnInit(): void {
    this.auth.getSession().subscribe((kratosSession) => {
      if (kratosSession?.active) {
        this.session.set({
          email: kratosSession.identity.traits.email,
          role: kratosSession.identity.traits.role,
        });
      }
    });
  }

  onLogout(): void {
    this.auth.logout();
  }
}
