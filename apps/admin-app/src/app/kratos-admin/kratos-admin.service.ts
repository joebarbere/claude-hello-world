import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface KratosIdentityTraits {
  email: string;
  role?: string;
}

export interface KratosIdentity {
  id: string;
  schema_id: string;
  traits: KratosIdentityTraits;
  state: string;
  created_at: string;
  updated_at: string;
}

export interface CreateIdentityPayload {
  schema_id: string;
  traits: KratosIdentityTraits;
  credentials?: {
    password?: {
      config: { password: string };
    };
  };
}

const KRATOS_ADMIN_URL = '/.ory/kratos/admin';

@Injectable({ providedIn: 'root' })
export class KratosAdminService {
  private readonly http = inject(HttpClient);

  listIdentities(): Observable<KratosIdentity[]> {
    return this.http.get<KratosIdentity[]>(`${KRATOS_ADMIN_URL}/admin/identities`);
  }

  getIdentity(id: string): Observable<KratosIdentity> {
    return this.http.get<KratosIdentity>(`${KRATOS_ADMIN_URL}/admin/identities/${id}`);
  }

  createIdentity(payload: CreateIdentityPayload): Observable<KratosIdentity> {
    return this.http.post<KratosIdentity>(`${KRATOS_ADMIN_URL}/admin/identities`, payload);
  }

  updateIdentityTraits(id: string, traits: KratosIdentityTraits): Observable<KratosIdentity> {
    return this.http.put<KratosIdentity>(`${KRATOS_ADMIN_URL}/admin/identities/${id}`, {
      schema_id: 'default',
      traits,
      state: 'active',
    });
  }

  deleteIdentity(id: string): Observable<void> {
    return this.http.delete<void>(`${KRATOS_ADMIN_URL}/admin/identities/${id}`);
  }

  checkHealth(): Observable<{ status: string }> {
    return this.http.get<{ status: string }>(`${KRATOS_ADMIN_URL}/health/alive`);
  }
}
