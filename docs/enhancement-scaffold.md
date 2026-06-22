# Human Enhancement Scaffold

This file is the project map for manual enhancements. Keep it close to the code and update it when a feature changes ownership, files, or acceptance tests.

## Enhancement Rules

- Keep production behavior unchanged until the new path has tests and a smoke command.
- Add new behavior behind a small interface, schema, or config flag before wiring it into the API.
- Prefer additive response fields over response-shape rewrites.
- Preserve the tenant boundary: every new read/write route must authenticate, identify a tenant, and return `404` for cross-tenant access.
- Preserve the sandbox boundary: every new runtime or runner feature must keep bounded CPU, memory, time, process count, file size, stdout, and stderr.
- Leave a short comment only at extension points where future readers need to know why a boundary exists.

## High-Value Enhancement Tracks

| Track | Primary files | What to add | Verification |
| --- | --- | --- | --- |
| New language runtime | `packages/common/src/index.ts`, `services/runner/src/language-profiles.ts`, `services/runner/Dockerfile`, `apps/frontend/src/index.html` | Add language schema, runtime profile, packages, and editor template | Submit/poll one successful job and one failing job |
| New admin dashboard metric | `services/api/src/index.ts`, `apps/frontend/src/index.html` | Add metric to `/v1/admin/metrics`, render card/timeline row | Load `/admin/observability`, verify metric updates |
| New runbook action | `services/api/src/index.ts`, `scripts/`, `infra/terraform/main.tf` | Add admin route, task/script, IAM permission, audit event | Trigger action, confirm audit stream entry |
| New persistence backend | `packages/common/src/index.ts`, `services/api/src/index.ts`, `services/runner/src/index.ts` | Add repository layer before moving Redis reads/writes | Submit job, poll result, list history, list audit |
| New AI feature | `services/api/src/analysis.ts`, `services/api/src/index.ts` | Add provider/config path with deterministic fallback | Force provider failure and confirm heuristic response |
| New quota policy | `services/api/src/quota.ts`, `services/api/src/tenants.ts`, `services/api/src/index.ts` | Add policy field and denial audit action | Unit test allowed/denied paths |

## Language Runtime Checklist

1. Add the language name to `SUPPORTED_LANGUAGES` in `packages/common/src/index.ts`.
2. Add a profile in `services/runner/src/language-profiles.ts`.
3. Install runtime/compiler dependencies in `services/runner/Dockerfile`.
4. Add an editor template and Monaco language mapping in `apps/frontend/src/index.html`.
5. Add local smoke examples to your manual test notes.
6. Run `npm run build`.
7. Run `./scripts/local-up.sh`, submit the new language, poll the result, then run `./scripts/local-down.sh`.

## Admin Dashboard Checklist

1. Add backend data to `/v1/admin/metrics`.
2. Keep AWS SDK calls server-side; never call AWS directly from browser code.
3. Add one visual element in `apps/frontend/src/index.html`.
4. Store no secrets in localStorage except the existing optional admin API key input.
5. Verify the dashboard still handles missing AWS permissions by rendering an error instead of breaking the page.

## Runbook Checklist

1. Put operational scripts under `scripts/`.
2. Trigger cloud work through a short-lived ECS task or a controlled API route.
3. Add an audit event before returning success to the caller.
4. Add Terraform IAM permissions for only the action required.
5. Document the manual fallback command in `README.md`.

## Safety Acceptance

Before exposing any new feature publicly, answer these questions in the PR or commit message:

- What tenant owns this operation?
- What Redis keys or cloud resources can it touch?
- What happens when Redis, ECS, or the AI provider fails?
- What is the max CPU, memory, runtime, and output size impact?
- What audit event proves the action happened?
- What command verifies the feature locally?
