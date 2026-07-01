---
name: real-user-audit
description: Audit a web front-end like a real user with Playwright, profile-specific journeys, screenshots, findings, maturity scoring, and a recommended development plan.
---

# Real User Audit

Use this skill when the user asks Codex to dogfood, audit, QA, review, or maturity-check a web product from a real user perspective. This MVP is for web front ends only, not native apps.

## Inputs

- Target URL.
- Profile: choose `student-learning` for education, homework, tutoring, classroom, practice, or study products. Choose `ai-chat` for general chat, assistant, agent, or prompt-entry products.
- Optional output directory. Default is `runtime/audits/latest`.

## Run

From the plugin root:

```bash
npx codex-product-dogfood audit <url> --profile <ai-chat|student-learning>
```

Example:

```bash
npx codex-product-dogfood audit https://staging.study.zhanzhanai.com --profile student-learning
```

The runner automatically audits:

- desktop: `1440x900`
- mobile: `390x844`
- small-mobile: `375x667`

## What The Runner Does

- Opens the URL with Playwright Chromium.
- Captures screenshots before and after primary actions.
- Clicks likely primary entry points based on the selected profile.
- Fills the best visible input with a realistic test question.
- Presses Enter to submit.
- Attempts a small upload when a file input exists.
- Captures DOM signals, console errors, and network failures.
- Writes `report.md`, `findings.json`, `signals.json`, viewport DOM snapshots, and `screenshots/`.

## Review Artifacts

Open `runtime/audits/latest/report.md` first, then inspect:

- `runtime/audits/latest/findings.json`
- `runtime/audits/latest/screenshots/`
- `runtime/audits/latest/signals.json`
- `runtime/audits/latest/*-dom.json`

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

If a GitHub remote is needed, ask after the local MVP is complete.
