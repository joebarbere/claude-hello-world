import { Component, inject, OnInit } from '@angular/core';
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
            <span class="status-badge" [ngClass]="healthState">{{ healthLabel }}</span>
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
          <input
            type="password"
            [(ngModel)]="newPassword"
            name="password"
            placeholder="Password"
            required
            class="form-input"
          />
          <select [(ngModel)]="newRole" name="role" class="form-input">
            <option value="">No role</option>
            <option value="admin">admin</option>
            <option value="weather_admin">weather_admin</option>
          </select>
          <button type="submit" class="btn btn-primary" [disabled]="creating">
            {{ creating ? 'Creating...' : 'Create' }}
          </button>
        </form>
        @if (createError) {
          <div class="msg msg-error">{{ createError }}</div>
        }
        @if (createSuccess) {
          <div class="msg msg-success">{{ createSuccess }}</div>
        }
      </section>

      <!-- Identities table -->
      <section class="table-section">
        <div class="section-header">
          <h2 class="section-title">Identities</h2>
          <button class="btn btn-secondary" (click)="loadIdentities()" [disabled]="loading">
            {{ loading ? 'Loading...' : 'Refresh' }}
          </button>
        </div>

        @if (loadError) {
          <div class="msg msg-error">{{ loadError }}</div>
        }

        @if (!loading && identities.length === 0 && !loadError) {
          <p class="empty">No identities found.</p>
        }

        @if (identities.length > 0) {
          <div class="table-wrapper">
            <table class="identity-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>State</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (identity of identities; track identity.id) {
                  <tr>
                    <td>{{ identity.traits.email }}</td>
                    <td>
                      @if (editingId === identity.id) {
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
                      @if (editingId === identity.id) {
                        <button class="btn btn-sm btn-primary" (click)="saveRole(identity)" [disabled]="saving">Save</button>
                        <button class="btn btn-sm btn-secondary" (click)="cancelEdit()">Cancel</button>
                      } @else {
                        <button class="btn btn-sm btn-secondary" (click)="startEdit(identity)">Edit Role</button>
                        <button class="btn btn-sm btn-danger" (click)="deleteIdentity(identity)" [disabled]="deletingId === identity.id">Delete</button>
                      }
                    </td>
                  </tr>
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
      font-family: system-ui, -apple-system, sans-serif;
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
    .header-icon { width: 32px; height: 32px; color: #6366f1; }
    .page-header h1 {
      font-size: 1.75rem;
      font-weight: 700;
      color: #111827;
      margin: 0;
    }
    .header-sub { color: #6b7280; margin: 0.5rem 0 0; }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .back-link {
      font-size: 0.875rem;
      color: #6366f1;
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
    .status-badge.up { background: #dcfce7; color: #166534; }
    .status-badge.down { background: #fee2e2; color: #991b1b; }
    .status-badge.pending { background: #f3f4f6; color: #6b7280; }
    .section-title {
      font-size: 1rem;
      font-weight: 600;
      color: #374151;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin: 0 0 0.75rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid #e5e7eb;
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
      border: 1px solid #d1d5db;
      border-radius: 6px;
      font-size: 0.875rem;
      outline: none;
    }
    .form-input:focus { border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,0.15); }
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
    .btn-primary { background: #6366f1; color: #fff; }
    .btn-primary:hover:not(:disabled) { background: #4f46e5; }
    .btn-secondary { background: #f3f4f6; color: #374151; }
    .btn-secondary:hover:not(:disabled) { background: #e5e7eb; }
    .btn-danger { background: #fee2e2; color: #991b1b; }
    .btn-danger:hover:not(:disabled) { background: #fecaca; }
    .btn-sm { padding: 0.25rem 0.5rem; font-size: 0.8rem; }
    .msg {
      margin-top: 0.5rem;
      padding: 0.5rem 0.75rem;
      border-radius: 6px;
      font-size: 0.875rem;
    }
    .msg-error { background: #fee2e2; color: #991b1b; }
    .msg-success { background: #dcfce7; color: #166534; }
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
      background: #f9fafb;
      border-bottom: 2px solid #e5e7eb;
      color: #374151;
      font-weight: 600;
    }
    .identity-table td {
      padding: 0.625rem 0.75rem;
      border-bottom: 1px solid #f3f4f6;
    }
    .identity-table tr:hover td { background: #f9fafb; }
    .role-badge {
      display: inline-block;
      padding: 0.1rem 0.4rem;
      border-radius: 4px;
      font-size: 0.8rem;
      font-weight: 500;
    }
    .role-badge.admin { background: #ede9fe; color: #5b21b6; }
    .role-badge.weather_admin { background: #dbeafe; color: #1e40af; }
    .role-badge.none { background: #f3f4f6; color: #6b7280; }
    .state-badge {
      display: inline-block;
      padding: 0.1rem 0.4rem;
      border-radius: 4px;
      font-size: 0.8rem;
      font-weight: 500;
    }
    .state-badge.active { background: #dcfce7; color: #166534; }
    .state-badge.inactive { background: #fee2e2; color: #991b1b; }
    .actions { white-space: nowrap; display: flex; gap: 0.35rem; }
    .empty { color: #6b7280; font-style: italic; }
  `],
})
export class KratosAdminComponent implements OnInit {
  private readonly kratosService = inject(KratosAdminService);

  identities: KratosIdentity[] = [];
  loading = false;
  loadError = '';

  // Health
  healthState = 'pending';
  healthLabel = 'Checking...';

  // Create form
  newEmail = '';
  newPassword = '';
  newRole = '';
  creating = false;
  createError = '';
  createSuccess = '';

  // Edit
  editingId: string | null = null;
  editRole = '';
  saving = false;

  // Delete
  deletingId: string | null = null;

  ngOnInit(): void {
    this.checkHealth();
    this.loadIdentities();
  }

  loadIdentities(): void {
    this.loading = true;
    this.loadError = '';
    this.kratosService.listIdentities().subscribe({
      next: (ids) => {
        this.identities = ids;
        this.loading = false;
      },
      error: (err) => {
        this.loadError = `Failed to load identities: ${err.message}`;
        this.loading = false;
      },
    });
  }

  createIdentity(): void {
    this.creating = true;
    this.createError = '';
    this.createSuccess = '';
    this.kratosService.createIdentity({
      schema_id: 'default',
      traits: {
        email: this.newEmail,
        ...(this.newRole ? { role: this.newRole } : {}),
      },
      credentials: {
        password: { config: { password: this.newPassword } },
      },
    }).subscribe({
      next: (created) => {
        this.createSuccess = `Created identity for ${created.traits.email}`;
        this.newEmail = '';
        this.newPassword = '';
        this.newRole = '';
        this.creating = false;
        this.loadIdentities();
      },
      error: (err) => {
        this.createError = `Failed to create identity: ${err.message}`;
        this.creating = false;
      },
    });
  }

  startEdit(identity: KratosIdentity): void {
    this.editingId = identity.id;
    this.editRole = identity.traits.role || '';
  }

  cancelEdit(): void {
    this.editingId = null;
    this.editRole = '';
  }

  saveRole(identity: KratosIdentity): void {
    this.saving = true;
    const traits = {
      email: identity.traits.email,
      ...(this.editRole ? { role: this.editRole } : {}),
    };
    this.kratosService.updateIdentityTraits(identity.id, traits).subscribe({
      next: () => {
        this.saving = false;
        this.editingId = null;
        this.loadIdentities();
      },
      error: () => {
        this.saving = false;
      },
    });
  }

  deleteIdentity(identity: KratosIdentity): void {
    this.deletingId = identity.id;
    this.kratosService.deleteIdentity(identity.id).subscribe({
      next: () => {
        this.deletingId = null;
        this.loadIdentities();
      },
      error: () => {
        this.deletingId = null;
      },
    });
  }

  formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString();
  }

  private checkHealth(): void {
    this.kratosService.checkHealth().subscribe({
      next: () => {
        this.healthState = 'up';
        this.healthLabel = 'Healthy';
      },
      error: () => {
        this.healthState = 'down';
        this.healthLabel = 'Down';
      },
    });
  }
}
