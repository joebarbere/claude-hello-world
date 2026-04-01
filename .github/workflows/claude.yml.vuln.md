# Vulnerability Report: .github/workflows/claude.yml

## MEDIUM: Claude Code Workflow Triggerable by Any GitHub User

**CWE:** CWE-284 — Improper Access Control

**Description:**
Trigger condition checks only for `@claude` in comment bodies with no restriction on comment author. On a public repo, any GitHub user can trigger the workflow.

**Exploitation Steps:**
1. External user comments `@claude` on any issue.
2. Workflow triggers with `CLAUDE_CODE_OAUTH_TOKEN` secret and `id-token: write`.
3. Prompt injection via issue comment could exfiltrate repo content.

**Remediation:** Add `author_association` check: `OWNER`, `MEMBER`, or `COLLABORATOR` only. Remove `id-token: write` if not needed.
