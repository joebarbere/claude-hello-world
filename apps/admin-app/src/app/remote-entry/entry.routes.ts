import { Route } from '@angular/router';
import { RemoteEntry } from './entry';
import { KratosAdminComponent } from '../kratos-admin/kratos-admin.component';

export const remoteRoutes: Route[] = [
  { path: '', component: RemoteEntry },
  { path: 'kratos', component: KratosAdminComponent },
];
