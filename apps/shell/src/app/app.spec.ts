import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { App } from './app';
import { NxWelcome } from './nx-welcome';
import { RouterTestingHarness } from '@angular/router/testing';
import { RouterModule } from '@angular/router';

describe('App', () => {
  beforeEach(async () => {
    await resolveComponentResources(() =>
      Promise.resolve({ text: () => Promise.resolve('') } as Response)
    );
    await TestBed.configureTestingModule({
      imports: [
        RouterModule.forRoot([{ path: '', component: NxWelcome }]),
        App,
        NxWelcome,
      ],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it(`should have as title 'shell'`, () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app.title).toEqual('shell');
  });

  it('should render title', async () => {
    const harness = await RouterTestingHarness.create('/');
    const compiled = harness.routeNativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Welcome shell');
  });
});
