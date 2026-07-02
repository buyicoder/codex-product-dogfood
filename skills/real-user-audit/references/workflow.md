# Workflow

1. Confirm the target is a web URL.
2. Pick `ai-chat` or `student-learning`.
3. Run the CLI from the plugin root, using either a built-in profile or `--profile-file`.
4. Inspect `report.md`, `findings.json`, screenshots, and `timeline.json`.
5. Convert confirmed problems into a short development plan.
6. Do not claim native-app coverage in this MVP.

For upload, send, streaming formula, Markdown table, and mobile composer/status issues, inspect the per-step manifests under `timeline/<viewport>/<journey>/<step>/manifest.json`. They preserve the keyframe sequence and link each event to screenshot, bbox, DOM/status, console, and network evidence.

Common commands:

```bash
npx codex-product-dogfood profiles
npx codex-product-dogfood audit <url> --profile student-learning
npx codex-product-dogfood audit <url> --profile-file templates/profile.yaml --viewport desktop
```
