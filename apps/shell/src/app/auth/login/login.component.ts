import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { AuthService, KratosFlowNode, KratosLoginFlow } from '../auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  template: `
    <div class="login-wrapper">
      <div class="login-card">
        <h1 class="login-title">Sign in</h1>

        @if (errorMessage) {
          <div class="login-error" role="alert">{{ errorMessage }}</div>
        }

        @if (flow) {
          @if (flow.ui.messages?.length) {
            <div class="login-error" role="alert">
              @for (msg of flow.ui.messages!; track msg.id) {
                <div>{{ msg.text }}</div>
              }
            </div>
          }

          <form [attr.action]="flow.ui.action" [attr.method]="flow.ui.method" class="login-form">
            @for (node of hiddenNodes(flow.ui.nodes); track node.attributes.name) {
              <input
                [type]="node.attributes.type"
                [name]="node.attributes.name"
                [value]="node.attributes.value ?? ''"
              />
            }

            <div class="form-group">
              <label for="identifier">Email</label>
              <input
                id="identifier"
                type="email"
                name="identifier"
                class="form-input"
                autocomplete="email"
                required
              />
              @for (node of fieldMessages('identifier', flow.ui.nodes); track node.id) {
                <span class="field-error">{{ node.text }}</span>
              }
            </div>

            <div class="form-group">
              <label for="password">Password</label>
              <input
                id="password"
                type="password"
                name="password"
                class="form-input"
                autocomplete="current-password"
                required
              />
              @for (node of fieldMessages('password', flow.ui.nodes); track node.id) {
                <span class="field-error">{{ node.text }}</span>
              }
            </div>

            <input type="hidden" name="method" value="password" />

            <button type="submit" class="btn-submit">Sign in</button>
          </form>
        } @else if (!errorMessage) {
          <p class="login-loading">Loading&hellip;</p>
        }
      </div>
    </div>
  `,
  styles: [`
    .login-wrapper {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f3f4f6;
    }
    .login-card {
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.1);
      padding: 2.5rem 2rem;
      width: 100%;
      max-width: 400px;
    }
    .login-title {
      font-size: 1.5rem;
      font-weight: 700;
      margin: 0 0 1.5rem;
      text-align: center;
    }
    .login-error {
      background: #fee2e2;
      color: #b91c1c;
      border-radius: 4px;
      padding: 0.75rem 1rem;
      margin-bottom: 1rem;
      font-size: 0.875rem;
    }
    .login-loading {
      text-align: center;
      color: #6b7280;
    }
    .form-group {
      margin-bottom: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.375rem;
    }
    label {
      font-size: 0.875rem;
      font-weight: 500;
      color: #374151;
    }
    .form-input {
      padding: 0.5rem 0.75rem;
      border: 1px solid #d1d5db;
      border-radius: 4px;
      font-size: 1rem;
      outline: none;
      transition: border-color 0.15s;
    }
    .form-input:focus {
      border-color: #6366f1;
      box-shadow: 0 0 0 2px rgba(99,102,241,0.2);
    }
    .field-error {
      color: #b91c1c;
      font-size: 0.75rem;
    }
    .btn-submit {
      width: 100%;
      padding: 0.625rem 1rem;
      background: #6366f1;
      color: #fff;
      border: none;
      border-radius: 4px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      margin-top: 0.5rem;
      transition: background 0.15s;
    }
    .btn-submit:hover {
      background: #4f46e5;
    }
  `],
})
export class LoginComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly authService = inject(AuthService);
  private readonly cdr = inject(ChangeDetectorRef);

  flowId: string | null = null;
  flow: KratosLoginFlow | null = null;
  errorMessage: string | null = null;

  ngOnInit(): void {
    this.flowId = this.route.snapshot.queryParamMap.get('flow');
    const returnTo =
      this.route.snapshot.queryParamMap.get('return_to') ?? '/weatheredit-app';

    if (!this.flowId) {
      this.authService.initiateLogin(returnTo);
      return;
    }

    this.authService.getLoginFlow(this.flowId).subscribe((flow) => {
      if (!flow) {
        // Flow could not be loaded (e.g. stale CSRF cookie). Start a fresh
        // login flow so the browser gets a new CSRF cookie that matches.
        this.authService.initiateLogin(returnTo);
        return;
      }
      this.errorMessage = null;
      this.flow = flow;
      this.cdr.detectChanges();
    });
  }

  hiddenNodes(nodes: KratosFlowNode[]): KratosFlowNode[] {
    return nodes.filter(
      (n) =>
        n.attributes.node_type === 'input' &&
        n.attributes.type === 'hidden' &&
        n.attributes.name !== 'method'
    );
  }

  fieldMessages(
    name: string,
    nodes: KratosFlowNode[]
  ): { id: number; text: string; type: string }[] {
    const node = nodes.find((n) => n.attributes.name === name);
    return node?.messages ?? [];
  }
}
