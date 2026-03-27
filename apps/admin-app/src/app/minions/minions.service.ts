import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type ScheduleType = 'Interval' | 'Cron' | 'DailyAt';

export interface Minion {
  id: number;
  name: string;
  scheduleType: ScheduleType;
  scheduleValue: string;
  isActive: boolean;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MinionPayload {
  name: string;
  scheduleType: ScheduleType;
  scheduleValue: string;
}

const API_URL = '/minions';

@Injectable({ providedIn: 'root' })
export class MinionsService {
  private readonly http = inject(HttpClient);

  list(): Observable<Minion[]> {
    return this.http.get<Minion[]>(API_URL);
  }

  get(id: number): Observable<Minion> {
    return this.http.get<Minion>(`${API_URL}/${id}`);
  }

  create(payload: MinionPayload): Observable<Minion> {
    return this.http.post<Minion>(API_URL, payload);
  }

  update(id: number, payload: MinionPayload): Observable<Minion> {
    return this.http.put<Minion>(`${API_URL}/${id}`, payload);
  }

  delete(id: number): Observable<void> {
    return this.http.delete<void>(`${API_URL}/${id}`);
  }

  start(id: number): Observable<Minion> {
    return this.http.post<Minion>(`${API_URL}/${id}/start`, {});
  }

  stop(id: number): Observable<Minion> {
    return this.http.post<Minion>(`${API_URL}/${id}/stop`, {});
  }
}
