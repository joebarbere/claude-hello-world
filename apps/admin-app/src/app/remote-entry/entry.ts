import { Component, inject, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { PageHeaderComponent, CardComponent, StatusBadgeComponent } from '@org/ui';

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
  {
    name: 'Minion Manager',
    routerLink: '/admin-app/minions',
    description: 'Create and manage automated weather event generators that run on a schedule.',
    category: 'Automation',
  },
  {
    name: 'Apache Airflow',
    url: 'http://localhost:8280',
    description: 'Orchestrate and monitor data pipelines and DAG workflows.',
    category: 'Data Science',
    credentials: { username: 'admin', password: 'admin' },
  },
  {
    name: 'Jupyter Lab',
    url: 'http://localhost:8888',
    description: 'Interactive notebooks with DuckDB, pandas, and MinIO integration.',
    category: 'Data Science',
    credentials: { username: 'token', password: 'datascience' },
  },
  {
    name: 'MinIO Console',
    url: 'http://localhost:9001',
    description: 'S3-compatible object storage for datasets, models, and artifacts.',
    category: 'Data Science',
    credentials: { username: 'minioadmin', password: 'minioadmin' },
  },
];

@Component({
  selector: 'app-admin-app-entry',
  standalone: true,
  imports: [RouterLink, PageHeaderComponent, CardComponent, StatusBadgeComponent],
  template: `
    <div class="page-container">
      <ui-page-header
        title="Admin Dashboard"
        subtitle="Quick links to infrastructure and admin services."
      ></ui-page-header>

      @for (category of categories; track category) {
        <section class="link-section">
          <h2 class="section-title">{{ category }}</h2>
          <div class="link-grid">
            @for (link of linksByCategory(category); track link.name) {
              <ui-card>
                @if (link.routerLink) {
                  <a [routerLink]="link.routerLink" class="link-card-inner">
                    <div class="link-header">
                      <div class="link-name">{{ link.name }}</div>
                      @if (link.badge) {
                        <ui-status-badge
                          [variant]="healthVariant(healthStatus[link.badge.endpoint] || 'pending')"
                        >
                          {{ healthLabels[healthStatus[link.badge.endpoint] || 'pending'] }}
                        </ui-status-badge>
                      }
                    </div>
                    <div class="link-desc">{{ link.description }}</div>
                    <div class="link-url">{{ link.routerLink }}</div>
                  </a>
                } @else {
                  <a [href]="link.url" target="_blank" rel="noopener noreferrer" class="link-card-inner">
                    <div class="link-header">
                      <div class="link-name">{{ link.name }}</div>
                      @if (link.badge) {
                        <ui-status-badge
                          [variant]="healthVariant(healthStatus[link.badge.endpoint] || 'pending')"
                        >
                          {{ healthLabels[healthStatus[link.badge.endpoint] || 'pending'] }}
                        </ui-status-badge>
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
              </ui-card>
            }
          </div>
        </section>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        font-family: var(--font-sans);
        -webkit-font-smoothing: antialiased;
      }
      .page-container {
        max-width: 960px;
        margin: 0 auto;
        padding: 32px 24px;
      }
      .link-section {
        margin-bottom: 24px;
      }
      .section-title {
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin: 0 0 12px;
        padding-bottom: 8px;
        border-bottom: 1px solid var(--border-color);
      }
      .link-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 12px;
      }
      .link-card-inner {
        display: block;
        padding: 18px 20px;
        text-decoration: none;
        color: inherit;
        transition: background 0.15s;
      }
      .link-card-inner:hover {
        background: var(--bg-surface-hover);
      }
      .link-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 6px;
      }
      .link-name {
        font-size: 0.9375rem;
        font-weight: 600;
        color: var(--text-primary);
      }
      .link-desc {
        font-size: 0.8125rem;
        color: var(--text-secondary);
        line-height: 1.4;
        margin-bottom: 8px;
      }
      .link-url {
        font-size: 0.75rem;
        color: var(--accent);
        font-family: var(--font-mono);
        word-break: break-all;
      }
      .credentials {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 0.8125rem;
        color: var(--text-secondary);
        margin-bottom: 8px;
      }
      .cred-label {
        font-weight: 500;
      }
      .credentials code {
        background: rgba(148, 163, 184, 0.1);
        padding: 1px 6px;
        border-radius: 4px;
        font-family: var(--font-mono);
        font-size: 0.8125rem;
      }
      @media (max-width: 640px) {
        .page-container { padding: 16px; }
        .link-grid { grid-template-columns: 1fr; }
      }
    `,
  ],
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

  healthVariant(status: string): string {
    if (status === 'up') return 'success';
    if (status === 'down') return 'danger';
    return 'neutral';
  }

  private checkHealth(endpoint: string): void {
    this.http.get(endpoint, { responseType: 'text' }).subscribe({
      next: () => (this.healthStatus[endpoint] = 'up'),
      error: () => (this.healthStatus[endpoint] = 'down'),
    });
  }
}
