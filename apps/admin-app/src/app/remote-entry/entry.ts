import { Component, inject, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { NgClass } from '@angular/common';
import { RouterLink } from '@angular/router';

export interface AdminLink {
  name: string;
  description: string;
  category: string;
  url?: string;
  routerLink?: string;
  badge?: { type: 'health'; endpoint: string };
  credentials?: { username: string; password: string };
}

const ADMIN_LINKS: AdminLink[] = [
  {
    name: 'Weather API Docs',
    url: 'http://localhost:5221/scalar/v1',
    description: 'Interactive Scalar API reference for the Weather Forecast REST API.',
    category: 'API',
  },
  {
    name: 'Ory Kratos Admin',
    routerLink: '/admin-app/kratos',
    description: 'Manage user identities, roles, and authentication.',
    category: 'Identity',
    badge: { type: 'health', endpoint: '/.ory/kratos/admin/health/alive' },
  },
  {
    name: 'Grafana Dashboard',
    url: 'http://localhost:3000',
    description: 'Metrics dashboards, alerting, and log exploration.',
    category: 'Observability',
    credentials: { username: 'admin', password: 'admin' },
  },
  {
    name: 'Kafka UI',
    url: '/kafka-ui',
    description: 'Browse Kafka topics, inspect CDC events, and manage Debezium connectors.',
    category: 'Infrastructure',
  },
  {
    name: 'Traefik Dashboard',
    url: 'http://localhost:8081',
    description: 'Reverse proxy routing, middleware, and TLS configuration.',
    category: 'Infrastructure',
  },
];

@Component({
  selector: 'app-admin-app-entry',
  standalone: true,
  imports: [NgClass, RouterLink],
  template: `
    <div class="page">
      <header class="page-header">
        <div class="header-title">
          <svg class="header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 15v2m-6 4h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2zm10-10V7a4 4 0 0 0-8 0v4h8z"/>
          </svg>
          <h1>Admin Dashboard</h1>
        </div>
        <p class="header-sub">Quick links to infrastructure and admin services.</p>
      </header>

      @for (category of categories; track category) {
        <section class="link-section">
          <h2 class="section-title">{{ category }}</h2>
          <div class="link-grid">
            @for (link of linksByCategory(category); track link.name) {
              @if (link.routerLink) {
                <a [routerLink]="link.routerLink" class="link-card">
                  <div class="link-header">
                    <div class="link-name">{{ link.name }}</div>
                    @if (link.badge) {
                      <span class="status-badge" [ngClass]="healthStatus[link.badge.endpoint] || 'pending'">
                        {{ healthLabels[healthStatus[link.badge.endpoint] || 'pending'] }}
                      </span>
                    }
                  </div>
                  <div class="link-desc">{{ link.description }}</div>
                  <div class="link-url">{{ link.routerLink }}</div>
                </a>
              } @else {
                <a [href]="link.url" target="_blank" rel="noopener noreferrer" class="link-card">
                  <div class="link-header">
                    <div class="link-name">{{ link.name }}</div>
                    @if (link.badge) {
                      <span class="status-badge" [ngClass]="healthStatus[link.badge.endpoint] || 'pending'">
                        {{ healthLabels[healthStatus[link.badge.endpoint] || 'pending'] }}
                      </span>
                    }
                  </div>
                  <div class="link-desc">{{ link.description }}</div>
                  @if (link.credentials) {
                    <div class="credentials">
                      <span class="cred-label">Login:</span>
                      <code>{{ link.credentials.username }}</code> / <code>{{ link.credentials.password }}</code>
                    </div>
                  }
                  <div class="link-url">{{ link.url }}</div>
                </a>
              }
            }
          </div>
        </section>
      }
    </div>
  `,
  styles: [`
    .page {
      max-width: 960px;
      margin: 0 auto;
      padding: 2rem 1.5rem;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .page-header {
      margin-bottom: 2rem;
    }
    .header-title {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .header-icon {
      width: 32px;
      height: 32px;
      color: #6366f1;
    }
    .page-header h1 {
      font-size: 1.75rem;
      font-weight: 700;
      color: #111827;
      margin: 0;
    }
    .header-sub {
      color: #6b7280;
      margin: 0.5rem 0 0;
    }
    .link-section {
      margin-bottom: 2rem;
    }
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
    .link-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 1rem;
    }
    .link-card {
      display: block;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 1.25rem;
      text-decoration: none;
      color: inherit;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .link-card:hover {
      border-color: #6366f1;
      box-shadow: 0 2px 12px rgba(99, 102, 241, 0.15);
    }
    .link-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.375rem;
    }
    .link-name {
      font-size: 1rem;
      font-weight: 600;
      color: #111827;
    }
    .link-desc {
      font-size: 0.875rem;
      color: #6b7280;
      line-height: 1.4;
      margin-bottom: 0.5rem;
    }
    .link-url {
      font-size: 0.75rem;
      color: #6366f1;
      font-family: ui-monospace, monospace;
      word-break: break-all;
    }
    .status-badge {
      font-size: 0.7rem;
      font-weight: 600;
      padding: 0.15rem 0.5rem;
      border-radius: 9999px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      flex-shrink: 0;
    }
    .status-badge.up {
      background: #dcfce7;
      color: #166534;
    }
    .status-badge.down {
      background: #fee2e2;
      color: #991b1b;
    }
    .status-badge.pending {
      background: #f3f4f6;
      color: #6b7280;
    }
    .credentials {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.8rem;
      color: #374151;
      margin-bottom: 0.5rem;
    }
    .cred-label {
      font-weight: 500;
    }
    .credentials code {
      background: #f3f4f6;
      padding: 0.1rem 0.35rem;
      border-radius: 4px;
      font-family: ui-monospace, monospace;
      font-size: 0.8rem;
    }
  `],
})
export class RemoteEntry implements OnInit {
  readonly links = ADMIN_LINKS;
  readonly categories = [...new Set(ADMIN_LINKS.map((l) => l.category))];
  readonly healthStatus: Record<string, string> = {};
  readonly healthLabels: Record<string, string> = {
    up: 'Healthy',
    down: 'Down',
    pending: 'Checking\u2026',
  };

  private readonly http = inject(HttpClient);

  ngOnInit(): void {
    for (const link of this.links) {
      if (link.badge?.type === 'health') {
        this.checkHealth(link.badge.endpoint);
      }
    }
  }

  linksByCategory(category: string): AdminLink[] {
    return this.links.filter((l) => l.category === category);
  }

  private checkHealth(endpoint: string): void {
    this.http.get(endpoint, { responseType: 'text' }).subscribe({
      next: () => (this.healthStatus[endpoint] = 'up'),
      error: () => (this.healthStatus[endpoint] = 'down'),
    });
  }
}
