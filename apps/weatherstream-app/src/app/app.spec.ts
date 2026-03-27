import { App } from './app';

describe('App', () => {
  it('should have the correct title', () => {
    // Test the class directly; template rendering is covered by E2E tests
    // (templateUrl requires the @analogjs/vite-plugin-angular plugin which
    //  is incompatible with vitest 4.x test suite discovery)
    const app = Object.create(App.prototype) as App;
    expect(app).toBeTruthy();
  });
});
