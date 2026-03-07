import { ModuleFederationConfig } from '@nx/module-federation';
import { join } from 'path';

const config: ModuleFederationConfig = {
  name: 'page2',
  exposes: {
    './Routes': join(__dirname, 'src/app/remote-entry/entry.routes.ts'),
  },
};

/**
 * Nx requires a default export of the config to allow correct resolution of the module federation graph.
 **/
export default config;
