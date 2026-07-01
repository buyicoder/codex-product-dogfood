# Workflow

1. Confirm the target is a web URL.
2. Pick `ai-chat` or `student-learning`.
3. Run the CLI from the plugin root, using either a built-in profile or `--profile-file`.
4. Inspect `report.md`, `findings.json`, and screenshots.
5. Convert confirmed problems into a short development plan.
6. Do not claim native-app coverage in this MVP.

Common commands:

```bash
npx codex-product-dogfood profiles
npx codex-product-dogfood audit <url> --profile student-learning
npx codex-product-dogfood audit <url> --profile-file templates/profile.yaml --viewport desktop
```
