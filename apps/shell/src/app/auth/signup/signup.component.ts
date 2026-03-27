import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { HttpClient } from '@angular/common/http';

@Component({
  selector: 'app-signup',
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <div class="signup-wrapper">
      <div class="signup-card">
        <h1 class="signup-title">Request Access</h1>
        <p class="signup-desc">Enter your email to request access. An admin will review your request.</p>

        @if (successMessage()) {
          <div class="msg msg-success">{{ successMessage() }}</div>
        } @else {
          <form (ngSubmit)="submit()">
            @if (errorMessage()) {
              <div class="msg msg-error">{{ errorMessage() }}</div>
            }
            <div class="form-group">
              <label for="email">Email</label>
              <input
                id="email"
                type="email"
                [(ngModel)]="email"
                name="email"
                class="form-input"
                autocomplete="email"
                required
              />
            </div>
            <button type="submit" class="btn-submit" [disabled]="submitting()">
              {{ submitting() ? 'Submitting...' : 'Request Access' }}
            </button>
          </form>
        }

        <a class="back-link" routerLink="/auth/login">Back to Sign in</a>
      </div>
    </div>
  `,
  styles: [`
    .signup-wrapper {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-body);
      font-family: var(--font-sans);
    }
    .signup-card {
      background: var(--bg-surface);
      border-radius: 8px;
      box-shadow: var(--shadow-md);
      padding: 2.5rem 2rem;
      width: 100%;
      max-width: 400px;
    }
    .signup-title {
      font-size: 1.5rem;
      font-weight: 700;
      margin: 0 0 0.5rem;
      text-align: center;
      color: var(--text-primary);
    }
    .signup-desc {
      text-align: center;
      color: var(--text-secondary);
      font-size: 0.875rem;
      margin: 0 0 1.5rem;
    }
    .form-group {
      margin-bottom: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.375rem;
    }
    label {
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--text-secondary);
    }
    .form-input {
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--border-color);
      border-radius: 4px;
      font-size: 1rem;
      outline: none;
      transition: border-color 0.15s;
      background: var(--bg-surface);
      color: var(--text-primary);
      font-family: var(--font-sans);
    }
    .form-input:focus {
      border-color: var(--accent-solid);
      box-shadow: 0 0 0 2px rgba(99,102,241,0.2);
    }
    .btn-submit {
      width: 100%;
      padding: 0.625rem 1rem;
      background: var(--accent-solid);
      color: #fff;
      border: none;
      border-radius: 4px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      margin-top: 0.5rem;
      transition: background 0.15s;
      font-family: var(--font-sans);
    }
    .btn-submit:hover:not(:disabled) { background: #4f46e5; }
    .btn-submit:disabled { opacity: 0.5; cursor: not-allowed; }
    .msg {
      border-radius: 4px;
      padding: 0.75rem 1rem;
      margin-bottom: 1rem;
      font-size: 0.875rem;
    }
    .msg-error { background: rgba(239, 68, 68, 0.15); color: #f87171; }
    .msg-success { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
    .back-link {
      display: block;
      text-align: center;
      margin-top: 1.25rem;
      font-size: 0.875rem;
      color: var(--accent);
      text-decoration: none;
    }
    .back-link:hover { text-decoration: underline; }
    @media (max-width: 480px) {
      .signup-wrapper { padding: 1rem; }
      .signup-card { padding: 1.5rem 1.25rem; }
    }
  `],
})
export class SignupComponent {
  private readonly http = inject(HttpClient);

  email = '';
  submitting = signal(false);
  errorMessage = signal('');
  successMessage = signal('');

  submit(): void {
    if (!this.email.trim()) return;

    this.submitting.set(true);
    this.errorMessage.set('');

    this.http.post<{ message?: string; error?: string }>('/signup', { email: this.email.trim() }).subscribe({
      next: (res) => {
        this.successMessage.set(
          res.message ?? 'Your request has been submitted. An administrator will review your access request.'
        );
        this.submitting.set(false);
      },
      error: (err) => {
        const msg = err.error?.error ?? err.error?.detail ?? 'Something went wrong. Please try again.';
        this.errorMessage.set(msg);
        this.submitting.set(false);
      },
    });
  }
}
