# Report Format

The report should include:

- URL, profile, generated time, viewports.
- Maturity score out of 100.
- Release readiness: `blocked`, `needs-work`, `usable`, or `strong`.
- P0/P1/P2 finding counts.
- Findings with evidence and repro steps.
- Recommended development plan with acceptance criteria.
- Manual review checklist for false positives and screenshot review.
- Bbox/overflow findings for mobile composer, upload, voice, send, and status controls that leave the viewport.
- `introducedAtStep` for bbox/overflow findings when per-step snapshots identify the first step where overflow appears.
- Profile-scoped critical-control classification so composer/status/upload/voice/send overflows stay high priority while unrelated off-canvas UI can be review-only.
- Timeline evidence for transient upload/send/formula/composer states. Review `timeline.json` plus per-step `timeline/<viewport>/<journey>/<step>/manifest.json` for keyframes including `before-step`, `after-click`, `after-file-select`, `uploading-100ms`, `uploading-500ms`, `uploading-1s`, `ready-to-send`, `after-send`, and `after-ai-started`.
- Timeline events should include screenshot, bbox, DOM/status summary, console summary, and network summary paths or inline counts.

The JSON report should preserve the same finding fields for automation.
