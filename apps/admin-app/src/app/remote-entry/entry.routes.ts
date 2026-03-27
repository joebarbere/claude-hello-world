import { Route } from '@angular/router';
import { RemoteEntry } from './entry';
import { KratosAdminComponent } from '../kratos-admin/kratos-admin.component';
import { MinionsComponent } from '../minions/minions.component';

export const remoteRoutes: Route[] = [
  { path: '', component: RemoteEntry },
  { path: 'kratos', component: KratosAdminComponent },
  { path: 'minions', component: MinionsComponent },
];
