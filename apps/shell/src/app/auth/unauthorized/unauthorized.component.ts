import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-unauthorized',
  standalone: true,
  template: `
    <div class="unauth-wrapper">
      <div class="unauth-card">
        <h1 class="unauth-title">Access Denied</h1>
        <p class="unauth-msg">
          You do not have permission to access this page.<br />
          Only <strong>admin</strong> and <strong>weather_admin</strong> users may access Weather Forecasts.
        </p>
        <div class="unauth-actions">
          <button class="btn-secondary" (click)="goHome()">Go to Home</button>
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
      background: #f3f4f6;
    }
    .unauth-card {
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.1);
      padding: 2.5rem 2rem;
      width: 100%;
      max-width: 480px;
      text-align: center;
    }
    .unauth-title {
      font-size: 1.5rem;
      font-weight: 700;
      color: #b91c1c;
      margin: 0 0 1rem;
    }
    .unauth-msg {
      color: #374151;
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
    }
    .btn-primary {
      background: #6366f1;
      color: #fff;
    }
    .btn-primary:hover { background: #4f46e5; }
    .btn-secondary {
      background: #e5e7eb;
      color: #374151;
    }
    .btn-secondary:hover { background: #d1d5db; }
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
