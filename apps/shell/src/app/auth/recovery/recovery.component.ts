import { Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-recovery',
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="recovery-wrapper">
      <div class="recovery-card">
        @if (checking()) {
          <p class="recovery-loading">Verifying your session...</p>
        } @else {
          <h1 class="recovery-title">Link Expired</h1>
          <p class="recovery-desc">This magic link is no longer valid. Please contact your administrator for a new one.</p>
          <a routerLink="/auth/login" class="btn-link">Go to Sign in</a>
        }
      </div>
    </div>
  `,
  styles: [`
    .recovery-wrapper {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f3f4f6;
    }
    .recovery-card {
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.1);
      padding: 2.5rem 2rem;
      width: 100%;
      max-width: 400px;
      text-align: center;
    }
    .recovery-title {
      font-size: 1.5rem;
      font-weight: 700;
      margin: 0 0 0.75rem;
    }
    .recovery-desc {
      color: #6b7280;
      font-size: 0.875rem;
      margin: 0 0 1.5rem;
    }
    .recovery-loading {
      color: #6b7280;
    }
    .btn-link {
      display: inline-block;
      padding: 0.625rem 1.5rem;
      background: #6366f1;
      color: #fff;
      border-radius: 4px;
      text-decoration: none;
      font-weight: 600;
    }
    .btn-link:hover { background: #4f46e5; }
  `],
})
export class RecoveryComponent implements OnInit {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  checking = signal(true);

  ngOnInit(): void {
    this.authService.getSession().subscribe((session) => {
      if (session?.active) {
        this.router.navigate(['/']);
      } else {
        this.checking.set(false);
      }
    });
  }
}
