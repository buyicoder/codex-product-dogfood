---
name: real-user-audit
description: Audit a web front-end like a real user with Playwright, profile-specific journeys, screenshots, findings, maturity scoring, and a recommended development plan.
---

# Real User Audit

Use this skill when the user asks Codex to dogfood, audit, QA, review, or maturity-check a web product from a real user perspective. This MVP is for web front ends only, not native apps.

## Inputs

- Target URL.
- Profile: choose `student-learning` for education, homework, tutoring, classroom, practice, or study products. Choose `ai-chat` for general chat, assistant, agent, or prompt-entry products.
- Optional YAML profile file via `--profile-file`.
- Optional output directory. Default is `runtime/audits/latest`.

## Run

From the plugin root:

```bash
npx codex-product-dogfood audit <url> --profile <ai-chat|student-learning>
```

Example:

```bash
npx codex-product-dogfood audit https://staging.study.zhanzhanai.com --profile student-learning
npx codex-product-dogfood audit https://example.com --profile-file templates/profile.yaml --viewport desktop
```

The runner automatically audits:

- desktop: `1440x900`
- mobile: `390x844`
- small-mobile: `375x667`

## What The Runner Does

- Opens the URL with Playwright Chromium.
- Executes profile journeys and steps.
- Captures screenshots before and after primary actions.
- Captures fine-grained timeline screenshots for step states such as `before-step`, `after-click`, `after-file-select`, `uploading-100ms`, `uploading-500ms`, `uploading-1s`, `ready-to-send`, `after-send`, and `after-ai-started`.
- Clicks likely primary entry points based on the selected profile.
- Fills the best visible input with a realistic test question.
- Presses Enter to submit.
- Attempts a small upload when a file input exists.
- Captures DOM signals, console errors, and network failures.
- Captures bounding boxes for visible buttons, form controls, status regions, and aria-labeled controls.
- Flags mobile composer/status regressions when visible controls have `x < 0` or `x + width > viewportWidth`.
- Saves per-step bbox snapshots so overflow findings can point to the first audited step where the issue appears.
- Uses profile-scoped `criticalControls` to keep bbox findings focused on composer, status, upload, voice, and send controls. Critical overflows are P1; other visible overflows are P2 review findings.
- Writes `report.md`, `findings.json`, `signals.json`, `run.json`, `timeline.json`, viewport DOM summaries, `screenshots/`, `timeline/`, and timeline contact sheets.

## Review Artifacts

Open `runtime/audits/latest/report.md` first, then inspect:

- `runtime/audits/latest/findings.json`
- `runtime/audits/latest/screenshots/`
- `runtime/audits/latest/signals.json`
- `runtime/audits/latest/run.json`
- `runtime/audits/latest/timeline.json`
- `runtime/audits/latest/dom/`
- `runtime/audits/latest/timeline/`
- `runtime/audits/latest/timeline/contact-sheet.html`

Mobile layout note: bbox/overflow findings are intended to catch composer, upload, voice, send, and status-copy regressions where controls are clipped or shifted offscreen at mobile widths such as `390x844` and `375x667`.
When available, bbox findings include `introducedAtStep` and link to the step-level bbox artifact, such as `dom/mobile-first-prompt-03-fill-bbox.json`.
Profile files may declare `criticalControls` with `selectorIncludes`, `role`, `textIncludes`, or `ariaLabelIncludes` so intentional off-canvas menus do not get treated like broken composer controls.

Timeline note: open `timeline/contact-sheet.html` first, then use `timeline.json` and each `timeline/<viewport>/<journey>/<step>/manifest.json` to review transient upload, send, Markdown table, streaming formula, and composer/status layout states. Each event includes a screenshot path, bbox path, DOM/status summary, and console/network summary.

Treat MVP findings as triage. Confirm screenshot evidence before making strong product claims.

## Findings

Every finding must include:

- `severity`
- `title`
- `journey`
- `viewport`
- `userSymptom`
- `expected`
- `actual`
- `evidence`
- `reproSteps`
- `acceptanceCriteria`

Severity guidance:

- `P0`: user cannot open or start the product.
- `P1`: core journey is blocked, broken, or misleading.
- `P2`: polish, discoverability, runtime warnings, or missing secondary affordances.

## Output

Summarize:

- Run command.
- Artifact paths.
- Maturity score and release readiness.
- Top P0/P1 findings.
- Recommended development plan.

Useful CLI helpers:

```bash
npx codex-product-dogfood profiles
npx codex-product-dogfood init-profile --out ./profile.yaml
```

If a GitHub remote is needed, ask after the local MVP is complete.
