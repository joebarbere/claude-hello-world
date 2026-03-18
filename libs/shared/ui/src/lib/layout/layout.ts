import { Component, inject, signal } from '@angular/core';
import { Router, RouterModule, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs/operators';

interface NavItem {
  label: string;
  icon: string;
  route: string;
}

@Component({
  selector: 'ui-layout',
  standalone: true,
  imports: [RouterModule],
  templateUrl: './layout.html',
  styleUrl: './layout.css',
})
export class LayoutComponent {
  private readonly router = inject(Router);

  sidebarCollapsed = signal(false);
  currentRoute = signal('/');

  readonly navItems: NavItem[] = [
    { label: 'Home', icon: 'pi pi-home', route: '/' },
    { label: 'Weather', icon: 'pi pi-cloud', route: '/weather-app' },
    {
      label: 'Forecasts',
      icon: 'pi pi-pencil',
      route: '/weatheredit-app',
    },
    { label: 'Admin', icon: 'pi pi-shield', route: '/admin-app' },
  ];

  constructor() {
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => this.currentRoute.set(e.urlAfterRedirects));
  }

  toggleSidebar(): void {
    this.sidebarCollapsed.update((v) => !v);
  }

  isActive(route: string): boolean {
    const current = this.currentRoute();
    if (route === '/') return current === '/';
    return current.startsWith(route);
  }
}
