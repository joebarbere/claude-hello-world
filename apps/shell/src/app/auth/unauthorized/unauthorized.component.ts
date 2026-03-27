import { Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-unauthorized',
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="unauth-wrapper">
      <div class="unauth-card">
        <h1 class="unauth-title">Access Denied</h1>
        <p class="unauth-msg">
          You do not have permission to access this page.<br />
          Your account may be pending approval. Contact an administrator for access.
        </p>
        <div class="unauth-actions">
          <button class="btn-secondary" (click)="goHome()">Go to Home</button>
          <a routerLink="/auth/signup" class="btn-secondary">Request Access</a>
          <button class="btn-primary" (click)="logout()">Sign out</button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .unauth-wrapper {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-body);
      font-family: var(--font-sans);
    }
    .unauth-card {
      background: var(--bg-surface);
      border-radius: 8px;
      box-shadow: var(--shadow-md);
      padding: 2.5rem 2rem;
      width: 100%;
      max-width: 480px;
      text-align: center;
    }
    .unauth-title {
      font-size: 1.5rem;
      font-weight: 700;
      color: #f87171;
      margin: 0 0 1rem;
    }
    .unauth-msg {
      color: var(--text-primary);
      line-height: 1.6;
      margin-bottom: 1.5rem;
    }
    .unauth-actions {
      display: flex;
      gap: 1rem;
      justify-content: center;
    }
    .btn-primary, .btn-secondary {
      padding: 0.5rem 1.25rem;
      border-radius: 4px;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: background 0.15s;
      font-family: var(--font-sans);
    }
    .btn-primary {
      background: var(--accent-solid);
      color: #fff;
    }
    .btn-primary:hover { background: #4f46e5; }
    .btn-secondary {
      background: var(--bg-surface-hover);
      color: var(--text-primary);
    }
    .btn-secondary:hover { background: var(--border-color); }
  `],
})
export class UnauthorizedComponent {
  private readonly router = inject(Router);
  private readonly authService = inject(AuthService);

  goHome(): void {
    this.router.navigate(['/']);
  }

  logout(): void {
    this.authService.logout();
  }
}
