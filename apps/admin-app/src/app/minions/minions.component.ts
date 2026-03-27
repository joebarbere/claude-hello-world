import { Component, inject, OnInit, signal } from '@angular/core';
import { NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { PageHeaderComponent, CardComponent, StatusBadgeComponent } from '@org/ui';
import { MinionsService, Minion, ScheduleType, MinionPayload } from './minions.service';

@Component({
  selector: 'app-minions',
  standalone: true,
  imports: [NgClass, FormsModule, RouterLink, PageHeaderComponent, CardComponent, StatusBadgeComponent],
  template: `
    <div class="page">
      <header class="page-header">
        <div class="header-row">
          <div class="header-title">
            <svg class="header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="8" r="5"/>
              <path d="M3 21v-2a7 7 0 0 1 7-7h4a7 7 0 0 1 7 7v2"/>
              <path d="M8 3 L6 1"/>
              <path d="M16 3 L18 1"/>
            </svg>
            <h1>Minion Manager</h1>
          </div>
          <a routerLink="/admin-app" class="back-link">Back to Dashboard</a>
        </div>
        <p class="header-sub">Create and manage automated weather event generators.</p>
      </header>

      <!-- Create form -->
      <section class="create-section">
        <h2 class="section-title">Create Minion</h2>
        <form class="create-form" (ngSubmit)="createMinion()">
          <input
            type="text"
            [(ngModel)]="newName"
            name="name"
            placeholder="Minion name"
            required
            class="form-input"
          />
          <select [(ngModel)]="newScheduleType" name="scheduleType" class="form-input" (ngModelChange)="onScheduleTypeChange()">
            <option value="Interval">Every N minutes</option>
            <option value="Cron">Cron expression</option>
            <option value="DailyAt">Daily at time</option>
          </select>
          @if (newScheduleType === 'Interval') {
            <div class="schedule-input-group">
              <span class="schedule-label">Every</span>
              <input
                type="number"
                [(ngModel)]="newIntervalMinutes"
                name="intervalMinutes"
                min="1"
                max="1440"
                required
                class="form-input form-input-narrow"
              />
              <span class="schedule-label">minutes</span>
            </div>
          }
          @if (newScheduleType === 'Cron') {
            <div class="schedule-input-group">
              <input
                type="text"
                [(ngModel)]="newCronExpression"
                name="cronExpression"
                placeholder="*/10 * * * *"
                required
                class="form-input"
              />
              <span class="schedule-hint" title="5-field cron: min hour dom mon dow">?</span>
            </div>
          }
          @if (newScheduleType === 'DailyAt') {
            <div class="schedule-input-group">
              <span class="schedule-label">at</span>
              <input
                type="time"
                [(ngModel)]="newDailyTime"
                name="dailyTime"
                required
                class="form-input"
              />
              <span class="schedule-label">UTC</span>
            </div>
          }
          <button type="submit" class="btn btn-primary" [disabled]="creating()">
            {{ creating() ? 'Creating...' : 'Create' }}
          </button>
        </form>
        @if (createError()) {
          <div class="msg msg-error">{{ createError() }}</div>
        }
        @if (createSuccess()) {
          <div class="msg msg-success">{{ createSuccess() }}</div>
        }
      </section>

      <!-- Minions table -->
      <section class="table-section">
        <div class="section-header">
          <h2 class="section-title">Minions</h2>
          <button class="btn btn-secondary" (click)="loadMinions()" [disabled]="loading()">
            {{ loading() ? 'Loading...' : 'Refresh' }}
          </button>
        </div>

        @if (loadError()) {
          <div class="msg msg-error">{{ loadError() }}</div>
        }

        @if (!loading() && minions().length === 0 && !loadError()) {
          <p class="empty">No minions created yet. Create one above to get started.</p>
        }

        @if (minions().length > 0) {
          <div class="table-wrapper">
            <table class="minion-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Schedule</th>
                  <th>Status</th>
                  <th>Last Run</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (minion of minions(); track minion.id) {
                  @if (editingId() === minion.id) {
                    <tr class="edit-row">
                      <td>
                        <input type="text" [(ngModel)]="editName" class="form-input form-input-sm" />
                      </td>
                      <td>
                        <div class="edit-schedule">
                          <select [(ngModel)]="editScheduleType" class="form-input form-input-sm" (ngModelChange)="onEditScheduleTypeChange()">
                            <option value="Interval">Interval</option>
                            <option value="Cron">Cron</option>
                            <option value="DailyAt">Daily At</option>
                          </select>
                          @if (editScheduleType === 'Interval') {
                            <div class="edit-schedule-value">
                              <input type="number" [(ngModel)]="editIntervalMinutes" min="1" class="form-input form-input-sm form-input-narrow" />
                              <span class="schedule-label-sm">min</span>
                            </div>
                          }
                          @if (editScheduleType === 'Cron') {
                            <input type="text" [(ngModel)]="editCronExpression" placeholder="*/10 * * * *" class="form-input form-input-sm" />
                          }
                          @if (editScheduleType === 'DailyAt') {
                            <div class="edit-schedule-value">
                              <input type="time" [(ngModel)]="editDailyTime" class="form-input form-input-sm" />
                              <span class="schedule-label-sm">UTC</span>
                            </div>
                          }
                        </div>
                      </td>
                      <td colspan="2"></td>
                      <td class="actions">
                        <button class="btn btn-sm btn-primary" (click)="saveEdit(minion)" [disabled]="saving()">Save</button>
                        <button class="btn btn-sm btn-secondary" (click)="cancelEdit()">Cancel</button>
                      </td>
                    </tr>
                  } @else {
                    <tr>
                      <td class="name-cell">{{ minion.name }}</td>
                      <td>
                        <span class="schedule-display">{{ formatSchedule(minion) }}</span>
                      </td>
                      <td>
                        <span class="state-badge" [ngClass]="minion.isActive ? 'active' : 'inactive'">
                          {{ minion.isActive ? 'Active' : 'Inactive' }}
                        </span>
                      </td>
                      <td>{{ formatLastRun(minion.lastRunAt) }}</td>
                      <td class="actions">
                        @if (minion.isActive) {
                          <button class="btn btn-sm btn-warning" (click)="stopMinion(minion)" [disabled]="togglingId() === minion.id">Stop</button>
                        } @else {
                          <button class="btn btn-sm btn-approve" (click)="startMinion(minion)" [disabled]="togglingId() === minion.id">Start</button>
                        }
                        <button class="btn btn-sm btn-secondary" (click)="startEdit(minion)">Edit</button>
                        <button class="btn btn-sm btn-danger" (click)="deleteMinion(minion)" [disabled]="deletingId() === minion.id">Delete</button>
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
    .back-link {
      font-size: 0.875rem;
      color: #6366f1;
      text-decoration: none;
    }
    .back-link:hover { text-decoration: underline; }
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
    .schedule-input-group {
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }
    .schedule-label {
      font-size: 0.875rem;
      color: #374151;
    }
    .schedule-label-sm {
      font-size: 0.8rem;
      color: #6b7280;
    }
    .schedule-hint {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: #e5e7eb;
      color: #6b7280;
      font-size: 0.75rem;
      font-weight: 600;
      cursor: help;
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
    .form-input-narrow { width: 80px; }
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
    .btn-approve { background: #dcfce7; color: #166534; }
    .btn-approve:hover:not(:disabled) { background: #bbf7d0; }
    .btn-warning { background: #fef3c7; color: #92400e; }
    .btn-warning:hover:not(:disabled) { background: #fde68a; }
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
    .minion-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }
    .minion-table th {
      text-align: left;
      padding: 0.625rem 0.75rem;
      background: #f9fafb;
      border-bottom: 2px solid #e5e7eb;
      color: #374151;
      font-weight: 600;
    }
    .minion-table td {
      padding: 0.625rem 0.75rem;
      border-bottom: 1px solid #f3f4f6;
    }
    .minion-table tr:hover td { background: #f9fafb; }
    .name-cell { font-weight: 500; color: #1e293b; }
    .schedule-display {
      font-family: ui-monospace, monospace;
      font-size: 0.8rem;
      color: #4b5563;
    }
    .state-badge {
      display: inline-block;
      padding: 0.1rem 0.4rem;
      border-radius: 4px;
      font-size: 0.8rem;
      font-weight: 500;
    }
    .state-badge.active { background: #dcfce7; color: #166534; }
    .state-badge.inactive { background: #f3f4f6; color: #6b7280; }
    .actions { white-space: nowrap; display: flex; gap: 0.35rem; align-items: center; }
    .edit-row td { background: #f0f9ff; }
    .edit-schedule {
      display: flex;
      gap: 0.35rem;
      align-items: center;
      flex-wrap: wrap;
    }
    .edit-schedule-value {
      display: flex;
      gap: 0.25rem;
      align-items: center;
    }
    .empty { color: #6b7280; font-style: italic; }
  `],
})
export class MinionsComponent implements OnInit {
  private readonly minionsService = inject(MinionsService);

  minions = signal<Minion[]>([]);
  loading = signal(false);
  loadError = signal('');

  // Create form
  newName = '';
  newScheduleType: ScheduleType = 'Interval';
  newIntervalMinutes = 5;
  newCronExpression = '';
  newDailyTime = '12:00';
  creating = signal(false);
  createError = signal('');
  createSuccess = signal('');

  // Edit
  editingId = signal<number | null>(null);
  editName = '';
  editScheduleType: ScheduleType = 'Interval';
  editIntervalMinutes = 5;
  editCronExpression = '';
  editDailyTime = '12:00';
  saving = signal(false);

  // Toggle (start/stop)
  togglingId = signal<number | null>(null);

  // Delete
  deletingId = signal<number | null>(null);

  ngOnInit(): void {
    this.loadMinions();
  }

  loadMinions(): void {
    this.loading.set(true);
    this.loadError.set('');
    this.minionsService.list().subscribe({
      next: (list) => {
        this.minions.set(list);
        this.loading.set(false);
      },
      error: (err) => {
        this.loadError.set(`Failed to load minions: ${err.message}`);
        this.loading.set(false);
      },
    });
  }

  createMinion(): void {
    this.creating.set(true);
    this.createError.set('');
    this.createSuccess.set('');
    const payload = this.buildPayload(
      this.newName, this.newScheduleType,
      this.newIntervalMinutes, this.newCronExpression, this.newDailyTime
    );
    this.minionsService.create(payload).subscribe({
      next: (created) => {
        this.createSuccess.set(`Created minion "${created.name}"`);
        this.newName = '';
        this.newIntervalMinutes = 5;
        this.newCronExpression = '';
        this.newDailyTime = '12:00';
        this.creating.set(false);
        this.loadMinions();
      },
      error: (err) => {
        this.createError.set(`Failed to create minion: ${err.message}`);
        this.creating.set(false);
      },
    });
  }

  startMinion(minion: Minion): void {
    this.togglingId.set(minion.id);
    this.minionsService.start(minion.id).subscribe({
      next: () => { this.togglingId.set(null); this.loadMinions(); },
      error: () => this.togglingId.set(null),
    });
  }

  stopMinion(minion: Minion): void {
    this.togglingId.set(minion.id);
    this.minionsService.stop(minion.id).subscribe({
      next: () => { this.togglingId.set(null); this.loadMinions(); },
      error: () => this.togglingId.set(null),
    });
  }

  startEdit(minion: Minion): void {
    this.editingId.set(minion.id);
    this.editName = minion.name;
    this.editScheduleType = minion.scheduleType;
    switch (minion.scheduleType) {
      case 'Interval':
        this.editIntervalMinutes = parseInt(minion.scheduleValue, 10) || 5;
        break;
      case 'Cron':
        this.editCronExpression = minion.scheduleValue;
        break;
      case 'DailyAt':
        this.editDailyTime = minion.scheduleValue;
        break;
    }
  }

  cancelEdit(): void {
    this.editingId.set(null);
  }

  saveEdit(minion: Minion): void {
    this.saving.set(true);
    const payload = this.buildPayload(
      this.editName, this.editScheduleType,
      this.editIntervalMinutes, this.editCronExpression, this.editDailyTime
    );
    this.minionsService.update(minion.id, payload).subscribe({
      next: () => {
        this.saving.set(false);
        this.editingId.set(null);
        this.loadMinions();
      },
      error: () => this.saving.set(false),
    });
  }

  deleteMinion(minion: Minion): void {
    this.deletingId.set(minion.id);
    this.minionsService.delete(minion.id).subscribe({
      next: () => {
        this.deletingId.set(null);
        this.loadMinions();
      },
      error: () => this.deletingId.set(null),
    });
  }

  onScheduleTypeChange(): void {
    // Reset values when switching type
  }

  onEditScheduleTypeChange(): void {
    // Reset edit values when switching type
  }

  formatSchedule(minion: Minion): string {
    switch (minion.scheduleType) {
      case 'Interval':
        return `Every ${minion.scheduleValue} min`;
      case 'Cron':
        return minion.scheduleValue;
      case 'DailyAt':
        return `Daily at ${minion.scheduleValue} UTC`;
      default:
        return minion.scheduleValue;
    }
  }

  formatLastRun(lastRunAt: string | null): string {
    if (!lastRunAt) return 'Never';
    const date = new Date(lastRunAt);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHrs = Math.floor(diffMin / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    return date.toLocaleDateString();
  }

  private buildPayload(
    name: string, scheduleType: ScheduleType,
    intervalMinutes: number, cronExpression: string, dailyTime: string
  ): MinionPayload {
    let scheduleValue: string;
    switch (scheduleType) {
      case 'Interval':
        scheduleValue = String(intervalMinutes);
        break;
      case 'Cron':
        scheduleValue = cronExpression;
        break;
      case 'DailyAt':
        scheduleValue = dailyTime;
        break;
    }
    return { name, scheduleType, scheduleValue };
  }
}
