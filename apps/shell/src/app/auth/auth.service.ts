import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

export interface KratosIdentity {
  id: string;
  traits: {
    email: string;
    role?: string;
  };
}

export interface KratosSession {
  id: string;
  active: boolean;
  identity: KratosIdentity;
}

const ALLOWED_ROLES = ['admin', 'weather_admin'];

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly kratosPublicUrl = '/.ory/kratos/public';

  getSession(): Observable<KratosSession | null> {
    return this.http
      .get<KratosSession>(`${this.kratosPublicUrl}/sessions/whoami`, {
        withCredentials: true,
      })
      .pipe(catchError(() => of(null)));
  }

  canAccessWeatherEdit(session: KratosSession | null): boolean {
    if (!session?.active) return false;
    const role = session.identity?.traits?.role;
    return role !== undefined && ALLOWED_ROLES.includes(role);
  }

  initiateLogin(returnTo: string): void {
    window.location.href = `${this.kratosPublicUrl}/self-service/login/browser?return_to=${encodeURIComponent(returnTo)}`;
  }

  logout(): void {
    this.http
      .get<{ logout_url: string }>(`${this.kratosPublicUrl}/self-service/logout/browser`, {
        withCredentials: true,
      })
      .pipe(catchError(() => of(null)))
      .subscribe((flow) => {
        if (flow?.logout_url) {
          window.location.href = flow.logout_url;
        }
      });
  }

  getLoginFlow(flowId: string): Observable<KratosLoginFlow | null> {
    return this.http
      .get<KratosLoginFlow>(
        `${this.kratosPublicUrl}/self-service/login/flows?id=${flowId}`,
        { withCredentials: true }
      )
      .pipe(catchError(() => of(null)));
  }
}

export interface KratosFlowNode {
  type: string;
  group: string;
  attributes: {
    name: string;
    type: string;
    value?: string;
    required?: boolean;
    disabled?: boolean;
    node_type: string;
  };
  messages: { id: number; text: string; type: string }[];
  meta: { label?: { id: number; text: string; type: string } };
}

export interface KratosLoginFlow {
  id: string;
  ui: {
    action: string;
    method: string;
    nodes: KratosFlowNode[];
    messages?: { id: number; text: string; type: string }[];
  };
}
