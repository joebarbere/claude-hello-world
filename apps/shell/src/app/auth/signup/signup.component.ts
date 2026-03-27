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
      background: #f3f4f6;
    }
    .signup-card {
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.1);
      padding: 2.5rem 2rem;
      width: 100%;
      max-width: 400px;
    }
    .signup-title {
      font-size: 1.5rem;
      font-weight: 700;
      margin: 0 0 0.5rem;
      text-align: center;
    }
    .signup-desc {
      text-align: center;
      color: #6b7280;
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
      color: #374151;
    }
    .form-input {
      padding: 0.5rem 0.75rem;
      border: 1px solid #d1d5db;
      border-radius: 4px;
      font-size: 1rem;
      outline: none;
      transition: border-color 0.15s;
    }
    .form-input:focus {
      border-color: #6366f1;
      box-shadow: 0 0 0 2px rgba(99,102,241,0.2);
    }
    .btn-submit {
      width: 100%;
      padding: 0.625rem 1rem;
      background: #6366f1;
      color: #fff;
      border: none;
      border-radius: 4px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      margin-top: 0.5rem;
      transition: background 0.15s;
    }
    .btn-submit:hover:not(:disabled) { background: #4f46e5; }
    .btn-submit:disabled { opacity: 0.5; cursor: not-allowed; }
    .msg {
      border-radius: 4px;
      padding: 0.75rem 1rem;
      margin-bottom: 1rem;
      font-size: 0.875rem;
    }
    .msg-error { background: #fee2e2; color: #b91c1c; }
    .msg-success { background: #dcfce7; color: #166534; }
    .back-link {
      display: block;
      text-align: center;
      margin-top: 1.25rem;
      font-size: 0.875rem;
      color: #6366f1;
      text-decoration: none;
    }
    .back-link:hover { text-decoration: underline; }
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
