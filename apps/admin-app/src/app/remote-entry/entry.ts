import { Component } from '@angular/core';

export interface AdminLink {
  name: string;
  url: string;
  description: string;
  category: string;
}

const ADMIN_LINKS: AdminLink[] = [
  {
    name: 'Weather API Swagger',
    url: 'http://localhost:5220/swagger',
    description: 'Interactive API documentation for the Weather Forecast REST API.',
    category: 'API',
  },
  {
    name: 'Ory Kratos Admin',
    url: 'http://localhost:4434/admin/identities',
    description: 'Manage user identities, sessions, and authentication flows.',
    category: 'Identity',
  },
  {
    name: 'Ory Kratos Health',
    url: 'http://localhost:4434/health/alive',
    description: 'Check Kratos admin health status.',
    category: 'Identity',
  },
  {
    name: 'Grafana Dashboard',
    url: 'http://localhost:3000',
    description: 'Metrics dashboards, alerting, and log exploration.',
    category: 'Observability',
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
              <a [href]="link.url" target="_blank" rel="noopener noreferrer" class="link-card">
                <div class="link-name">{{ link.name }}</div>
                <div class="link-desc">{{ link.description }}</div>
                <div class="link-url">{{ link.url }}</div>
              </a>
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
    .link-name {
      font-size: 1rem;
      font-weight: 600;
      color: #111827;
      margin-bottom: 0.375rem;
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
  `],
})
export class RemoteEntry {
  readonly links = ADMIN_LINKS;
  readonly categories = [...new Set(ADMIN_LINKS.map((l) => l.category))];

  linksByCategory(category: string): AdminLink[] {
    return this.links.filter((l) => l.category === category);
  }
}
