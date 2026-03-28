import { Component, inject, OnInit, signal } from '@angular/core';
import { NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  KratosAdminService,
  KratosIdentity,
} from './kratos-admin.service';

@Component({
  selector: 'app-kratos-admin',
  standalone: true,
  imports: [NgClass, FormsModule, RouterLink],
  template: `
    <div class="page">
      <header class="page-header">
        <div class="header-row">
          <div class="header-title">
            <svg class="header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
            <h1>Identity Management</h1>
          </div>
          <div class="header-actions">
            <a routerLink="/admin-app" class="back-link">Back to Dashboard</a>
          </div>
        </div>
        <p class="header-sub">Manage Ory Kratos user identities and roles.</p>
      </header>

      <!-- Create identity form -->
      <section class="create-section">
        <h2 class="section-title">Create Identity</h2>
        <form class="create-form" (ngSubmit)="createIdentity()">
          <input
            type="email"
            [(ngModel)]="newEmail"
            name="email"
            placeholder="Email address"
            required
            class="form-input"
          />
          <select [(ngModel)]="newRole" name="role" class="form-input">
            <option value="">No role</option>
            <option value="admin">admin</option>
            <option value="weather_admin">weather_admin</option>
          </select>
          <button type="submit" class="btn btn-primary" [disabled]="creating()">
            {{ creating() ? 'Creating...' : 'Create' }}
          </button>
        </form>
        <p class="create-hint">Identity is created as inactive. Approve it below to grant access.</p>
        @if (createError()) {
          <div class="msg msg-error">{{ createError() }}</div>
        }
        @if (createSuccess()) {
          <div class="msg msg-success">{{ createSuccess() }}</div>
        }
      </section>

      <!-- Identities table -->
      <section class="table-section">
        <div class="section-header">
          <h2 class="section-title">Identities</h2>
          <button class="btn btn-secondary" (click)="loadIdentities()" [disabled]="loading()">
            {{ loading() ? 'Loading...' : 'Refresh' }}
          </button>
        </div>

        @if (loadError()) {
          <div class="msg msg-error">{{ loadError() }}</div>
        }

        @if (!loading() && identities().length === 0 && !loadError()) {
          <p class="empty">No identities found.</p>
        }

        @if (identities().length > 0) {
          <div class="table-wrapper">
            <table class="identity-table">
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">State</th>
                  <th scope="col">Created</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (identity of identities(); track identity.id) {
                  <tr>
                    <td>{{ identity.traits.email }}</td>
                    <td>
                      @if (editingId() === identity.id) {
                        <select [(ngModel)]="editRole" class="form-input form-input-sm">
                          <option value="">No role</option>
                          <option value="admin">admin</option>
                          <option value="weather_admin">weather_admin</option>
                        </select>
                      } @else {
                        <span class="role-badge" [ngClass]="identity.traits.role || 'none'">
                          {{ identity.traits.role || 'none' }}
                        </span>
                      }
                    </td>
                    <td>
                      <span class="state-badge" [ngClass]="identity.state">{{ identity.state }}</span>
                    </td>
                    <td>{{ formatDate(identity.created_at) }}</td>
                    <td class="actions">
                      @if (editingId() === identity.id) {
                        <button class="btn btn-sm btn-primary" (click)="saveRole(identity)" [disabled]="saving()">Save</button>
                        <button class="btn btn-sm btn-secondary" (click)="cancelEdit()">Cancel</button>
                      } @else if (approvingId() === identity.id) {
                        <select [(ngModel)]="approveRole" class="form-input form-input-sm">
                          <option value="">No role</option>
                          <option value="admin">admin</option>
                          <option value="weather_admin">weather_admin</option>
                        </select>
                        <button class="btn btn-sm btn-primary" (click)="approveUser(identity)">Confirm</button>
                        <button class="btn btn-sm btn-secondary" (click)="cancelApprove()">Cancel</button>
                      } @else {
                        @if (identity.state === 'inactive') {
                          <button class="btn btn-sm btn-approve" (click)="startApprove(identity)">Approve</button>
                        }
                        @if (identity.state === 'active') {
                          <button class="btn btn-sm btn-secondary" (click)="startEdit(identity)">Edit Role</button>
                          <button class="btn btn-sm btn-secondary" (click)="generateLink(identity)"
                            [disabled]="generatingLinkId() === identity.id">
                            {{ generatingLinkId() === identity.id ? 'Generating...' : 'Magic Link' }}
                          </button>
                          <button class="btn btn-sm btn-warning" (click)="deactivateUser(identity)">Deactivate</button>
                        }
                        <button class="btn btn-sm btn-danger" (click)="deleteIdentity(identity)" [disabled]="deletingId() === identity.id">Delete</button>
                      }
                    </td>
                  </tr>
                  @if (magicLink()?.id === identity.id) {
                    <tr class="magic-link-row">
                      <td colspan="5">
                        <div class="magic-link-container">
                          <input type="text" [value]="magicLink()!.link" readonly class="form-input magic-link-input" />
                          <button class="btn btn-sm btn-primary" (click)="copyLink()">
                            {{ linkCopied() ? 'Copied!' : 'Copy' }}
                          </button>
                        </div>
                      </td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    </div>
  `,
  styles: [`
    .page {
      max-width: 960px;
      margin: 0 auto;
      padding: 2rem 1.5rem;
      font-family: var(--font-sans);
    }
    .page-header { margin-bottom: 2rem; }
    .header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 0.75rem;
    }
    .header-title {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .header-icon { width: 32px; height: 32px; color: var(--accent-solid); }
    .page-header h1 {
      font-size: 1.75rem;
      font-weight: 700;
      color: var(--text-primary);
      margin: 0;
    }
    .header-sub { color: var(--text-secondary); margin: 0.5rem 0 0; }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .back-link {
      font-size: 0.875rem;
      color: var(--accent);
      text-decoration: none;
    }
    .back-link:hover { text-decoration: underline; }
    .status-badge {
      font-size: 0.7rem;
      font-weight: 600;
      padding: 0.15rem 0.5rem;
      border-radius: 9999px;
      text-transform: uppercase;
    }
    .status-badge.up { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
    .status-badge.down { background: rgba(239, 68, 68, 0.15); color: #f87171; }
    .status-badge.pending { background: rgba(148, 163, 184, 0.15); color: var(--text-secondary); }
    .section-title {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-primary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin: 0 0 0.75rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid var(--border-color);
    }
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .section-header .section-title { flex: 1; }
    .create-section { margin-bottom: 2rem; }
    .create-form {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      align-items: center;
    }
    .form-input {
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      font-size: 0.875rem;
      outline: none;
      background: var(--bg-surface);
      color: var(--text-primary);
    }
    .form-input:focus { border-color: var(--accent-solid); box-shadow: 0 0 0 2px rgba(99,102,241,0.15); }
    .form-input-sm { padding: 0.25rem 0.5rem; font-size: 0.8rem; }
    .btn {
      padding: 0.5rem 1rem;
      border: none;
      border-radius: 6px;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: var(--accent-solid); color: #fff; }
    .btn-primary:hover:not(:disabled) { background: #4f46e5; }
    .btn-secondary { background: var(--bg-surface-hover); color: var(--text-primary); }
    .btn-secondary:hover:not(:disabled) { background: var(--border-color); }
    .btn-danger { background: rgba(239, 68, 68, 0.15); color: #f87171; }
    .btn-danger:hover:not(:disabled) { background: rgba(239, 68, 68, 0.3); }
    .btn-sm { padding: 0.25rem 0.5rem; font-size: 0.8rem; }
    .msg {
      margin-top: 0.5rem;
      padding: 0.5rem 0.75rem;
      border-radius: 6px;
      font-size: 0.875rem;
    }
    .msg-error { background: rgba(239, 68, 68, 0.15); color: #f87171; }
    .msg-success { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
    .table-section { margin-bottom: 2rem; }
    .table-wrapper { overflow-x: auto; }
    .identity-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }
    .identity-table th {
      text-align: left;
      padding: 0.625rem 0.75rem;
      background: var(--bg-body);
      border-bottom: 2px solid var(--border-color);
      color: var(--text-primary);
      font-weight: 600;
    }
    .identity-table td {
      padding: 0.625rem 0.75rem;
      border-bottom: 1px solid var(--border-color);
    }
    .identity-table tr:hover td { background: var(--bg-surface-hover); }
    .role-badge {
      display: inline-block;
      padding: 0.1rem 0.4rem;
      border-radius: 4px;
      font-size: 0.8rem;
      font-weight: 500;
    }
    .role-badge.admin { background: rgba(139, 92, 246, 0.15); color: #a78bfa; }
    .role-badge.weather_admin { background: rgba(59, 130, 246, 0.15); color: #60a5fa; }
    .role-badge.none { background: rgba(148, 163, 184, 0.15); color: var(--text-secondary); }
    .state-badge {
      display: inline-block;
      padding: 0.1rem 0.4rem;
      border-radius: 4px;
      font-size: 0.8rem;
      font-weight: 500;
    }
    .state-badge.active { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
    .state-badge.inactive { background: rgba(239, 68, 68, 0.15); color: #f87171; }
    .actions { white-space: nowrap; display: flex; gap: 0.35rem; align-items: center; }
    .btn-approve { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
    .btn-approve:hover:not(:disabled) { background: rgba(34, 197, 94, 0.25); }
    .btn-warning { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
    .btn-warning:hover:not(:disabled) { background: rgba(245, 158, 11, 0.25); }
    .magic-link-row td { background: var(--accent-muted); padding: 0.5rem 0.75rem; }
    .magic-link-container { display: flex; gap: 0.5rem; align-items: center; }
    .magic-link-input { flex: 1; font-size: 0.8rem; font-family: var(--font-mono); }
    .create-hint { color: var(--text-secondary); font-size: 0.8rem; margin-top: 0.5rem; }
    .empty { color: var(--text-secondary); font-style: italic; }
    @media (max-width: 640px) {
      .page { padding: 1rem; }
      .identity-table th, .identity-table td { padding: 0.4rem 0.5rem; font-size: 0.8rem; }
      .create-form { flex-direction: column; }
      .create-form .form-input, .create-form .btn { width: 100%; }
    }
  `],
})
export class KratosAdminComponent implements OnInit {
  private readonly kratosService = inject(KratosAdminService);

  identities = signal<KratosIdentity[]>([]);
  loading = signal(false);
  loadError = signal('');

  // Health
  healthState = signal('pending');
  healthLabel = signal('Checking...');

  // Create form
  newEmail = '';
  newRole = '';
  creating = signal(false);
  createError = signal('');
  createSuccess = signal('');

  // Edit
  editingId = signal<string | null>(null);
  editRole = '';
  saving = signal(false);

  // Delete
  deletingId = signal<string | null>(null);

  // Approve
  approvingId = signal<string | null>(null);
  approveRole = '';

  // Magic link
  magicLink = signal<{ id: string; link: string } | null>(null);
  generatingLinkId = signal<string | null>(null);
  linkCopied = signal(false);

  ngOnInit(): void {
    this.checkHealth();
    this.loadIdentities();
  }

  loadIdentities(): void {
    this.loading.set(true);
    this.loadError.set('');
    this.kratosService.listIdentities().subscribe({
      next: (ids) => {
        this.identities.set(ids);
        this.loading.set(false);
      },
      error: (err) => {
        this.loadError.set(`Failed to load identities: ${err.message}`);
        this.loading.set(false);
      },
    });
  }

  createIdentity(): void {
    this.creating.set(true);
    this.createError.set('');
    this.createSuccess.set('');
    this.kratosService.createIdentity({
      schema_id: 'default',
      traits: {
        email: this.newEmail,
        ...(this.newRole ? { role: this.newRole } : {}),
      },
      credentials: {
        password: { config: { password: crypto.randomUUID() } },
      },
    }).subscribe({
      next: (created) => {
        this.createSuccess.set(`Created identity for ${created.traits.email}`);
        this.newEmail = '';
        this.newRole = '';
        this.creating.set(false);
        this.loadIdentities();
      },
      error: (err) => {
        this.createError.set(`Failed to create identity: ${err.message}`);
        this.creating.set(false);
      },
    });
  }

  startEdit(identity: KratosIdentity): void {
    this.editingId.set(identity.id);
    this.editRole = identity.traits.role || '';
  }

  cancelEdit(): void {
    this.editingId.set(null);
    this.editRole = '';
  }

  saveRole(identity: KratosIdentity): void {
    this.saving.set(true);
    const traits = {
      email: identity.traits.email,
      ...(this.editRole ? { role: this.editRole } : {}),
    };
    this.kratosService.updateIdentityTraits(identity.id, traits).subscribe({
      next: () => {
        this.saving.set(false);
        this.editingId.set(null);
        this.loadIdentities();
      },
      error: () => {
        this.saving.set(false);
      },
    });
  }

  deleteIdentity(identity: KratosIdentity): void {
    this.deletingId.set(identity.id);
    this.kratosService.deleteIdentity(identity.id).subscribe({
      next: () => {
        this.deletingId.set(null);
        this.loadIdentities();
      },
      error: () => {
        this.deletingId.set(null);
      },
    });
  }

  startApprove(identity: KratosIdentity): void {
    this.approvingId.set(identity.id);
    this.approveRole = '';
  }

  cancelApprove(): void {
    this.approvingId.set(null);
    this.approveRole = '';
  }

  approveUser(identity: KratosIdentity): void {
    const traits = {
      email: identity.traits.email,
      ...(this.approveRole ? { role: this.approveRole } : {}),
    };
    this.kratosService.activateIdentity(identity.id, traits).subscribe({
      next: () => {
        this.approvingId.set(null);
        this.loadIdentities();
      },
      error: () => this.approvingId.set(null),
    });
  }

  deactivateUser(identity: KratosIdentity): void {
    this.kratosService.deactivateIdentity(identity.id, identity.traits).subscribe({
      next: () => this.loadIdentities(),
    });
  }

  generateLink(identity: KratosIdentity): void {
    this.generatingLinkId.set(identity.id);
    this.magicLink.set(null);
    this.linkCopied.set(false);
    this.kratosService.generateRecoveryLink(identity.id).subscribe({
      next: (resp) => {
        this.magicLink.set({ id: identity.id, link: resp.recovery_link });
        this.generatingLinkId.set(null);
      },
      error: () => this.generatingLinkId.set(null),
    });
  }

  copyLink(): void {
    const link = this.magicLink()?.link;
    if (link) {
      navigator.clipboard.writeText(link);
      this.linkCopied.set(true);
    }
  }

  formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString();
  }

  private checkHealth(): void {
    this.kratosService.checkHealth().subscribe({
      next: () => {
        this.healthState.set('up');
        this.healthLabel.set('Healthy');
      },
      error: () => {
        this.healthState.set('down');
        this.healthLabel.set('Down');
      },
    });
  }
}
