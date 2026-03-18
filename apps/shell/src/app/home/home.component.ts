import { Component, inject, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';
import { PageHeaderComponent, CardComponent } from '@org/ui';
import { AuthService, KratosSession } from '../auth/auth.service';

interface DashboardLink {
  title: string;
  description: string;
  route: string;
  icon: string;
}

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [PageHeaderComponent, CardComponent],
  template: `
    <div class="page-container">
      <ui-page-header
        title="Dashboard"
        subtitle="Welcome to the NxWeather application."
      ></ui-page-header>

      @if (session()) {
        <div class="user-greeting">
          <i class="pi pi-user"></i>
          Signed in as <strong>{{ session()!.identity.traits.email }}</strong>
          <span class="role-badge">{{ session()!.identity.traits.role ?? 'user' }}</span>
        </div>
      }

      <div class="link-grid">
        @for (link of links; track link.route) {
          <ui-card>
            <a class="link-card-inner" (click)="navigate(link.route)">
              <i [class]="link.icon + ' link-icon'"></i>
              <div>
                <div class="link-title">{{ link.title }}</div>
                <div class="link-desc">{{ link.description }}</div>
              </div>
              <i class="pi pi-arrow-right link-arrow"></i>
            </a>
          </ui-card>
        }
      </div>
    </div>
  `,
  styles: [
    `
      .user-greeting {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 16px;
        background: #eef2ff;
        border-radius: 8px;
        font-size: 0.875rem;
        color: #4338ca;
        margin-bottom: 24px;
      }
      .role-badge {
        background: #c7d2fe;
        color: #3730a3;
        padding: 2px 8px;
        border-radius: 9999px;
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
      }
      .link-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 16px;
      }
      .link-card-inner {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 20px;
        text-decoration: none;
        color: inherit;
        cursor: pointer;
        transition: background 0.15s;
      }
      .link-card-inner:hover {
        background: #f8fafc;
      }
      .link-icon {
        font-size: 1.25rem;
        color: #6366f1;
        flex-shrink: 0;
        width: 24px;
        text-align: center;
      }
      .link-title {
        font-weight: 600;
        font-size: 0.9375rem;
        color: #1e293b;
        margin-bottom: 2px;
      }
      .link-desc {
        font-size: 0.8125rem;
        color: #64748b;
      }
      .link-arrow {
        margin-left: auto;
        color: #cbd5e1;
        font-size: 0.875rem;
        flex-shrink: 0;
      }
    `,
  ],
})
export class HomeComponent implements OnInit {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  session = signal<KratosSession | null>(null);

  readonly links: DashboardLink[] = [
    {
      title: 'Weather Forecast',
      description: 'View current weather forecast data.',
      route: '/weather-app',
      icon: 'pi pi-cloud',
    },
    {
      title: 'Manage Forecasts',
      description: 'Create, edit, and delete forecasts.',
      route: '/weatheredit-app',
      icon: 'pi pi-pencil',
    },
    {
      title: 'Admin Dashboard',
      description: 'Infrastructure and identity management.',
      route: '/admin-app',
      icon: 'pi pi-shield',
    },
  ];

  ngOnInit(): void {
    this.authService.getSession().subscribe((s) => this.session.set(s));
  }

  navigate(route: string): void {
    this.router.navigate([route]);
  }
}
