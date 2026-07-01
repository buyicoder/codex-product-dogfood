# codex-product-dogfood

Codex plugin and CLI for web front-end product dogfooding. It opens a target URL with Playwright, runs profile-based journeys across desktop and mobile viewports, captures screenshots and runtime signals, then writes findings and a development plan.

## Quick start

```bash
npm install
npm run build
npx codex-product-dogfood audit https://staging.study.zhanzhanai.com --profile student-learning
```

Default output:

```text
runtime/audits/latest/report.md
runtime/audits/latest/findings.json
runtime/audits/latest/screenshots/
```

## Profiles

- `ai-chat`: chat input, send actions, upload, voice, empty/error states.
- `student-learning`: learning entry points, question practice, formula affordances, upload, voice, empty/error states.

## CLI

```bash
codex-product-dogfood audit <url> --profile ai-chat
codex-product-dogfood audit <url> --profile student-learning --out runtime/audits/my-run
codex-product-dogfood audit <url> --profile-file templates/profile.yaml --viewport desktop
codex-product-dogfood profiles
codex-product-dogfood init-profile --out ./my-profile.yaml
```
