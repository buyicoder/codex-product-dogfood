import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { classifyBBoxOverflow, detectBBoxOverflows, findIntroducedAtStep, timelineEventNamesForStep, writeTimelineStepContactSheet, writeTimelineStepManifest, type BBoxElement, type BBoxOverflow, type BBoxSnapshot, type TimelineEvent } from "./index.js";

describe("bbox overflow detection", () => {
  it("detects visible elements that cross viewport edges", () => {
    const elements: BBoxElement[] = [
      {
        selector: "button[aria-label=\"Send\"]",
        ariaLabel: "Send",
        bbox: { x: -12, y: 700, width: 44, height: 44 }
      },
      {
        selector: "textarea",
        bbox: { x: 16, y: 650, width: 320, height: 80 }
      },
      {
        selector: "div[role=\"status\"]",
        role: "status",
        text: "Uploading a very long filename",
        bbox: { x: 300, y: 720, width: 140, height: 24 }
      }
    ];

    expect(detectBBoxOverflows(elements, 390)).toEqual([
      {
        selector: "button[aria-label=\"Send\"]",
        ariaLabel: "Send",
        bbox: { x: -12, y: 700, width: 44, height: 44 },
        viewportWidth: 390,
        overflowLeft: 12,
        overflowRight: 0
      },
      {
        selector: "div[role=\"status\"]",
        role: "status",
        text: "Uploading a very long filename",
        bbox: { x: 300, y: 720, width: 140, height: 24 },
        viewportWidth: 390,
        overflowLeft: 0,
        overflowRight: 50
      }
    ]);
  });

  it("finds the first step snapshot that introduced an overflow", () => {
    const overflow: BBoxOverflow = {
      selector: "button[aria-label=\"Send\"]",
      ariaLabel: "Send",
      bbox: { x: -12, y: 700, width: 44, height: 44 },
      viewportWidth: 390,
      overflowLeft: 12,
      overflowRight: 0
    };
    const snapshots: BBoxSnapshot[] = [
      {
        stepIndex: 1,
        stepLabel: "Open",
        action: "open",
        screenshot: "/tmp/open.png",
        artifactPath: "/tmp/open-bbox.json",
        elements: [],
        overflows: []
      },
      {
        stepIndex: 2,
        stepLabel: "Upload homework",
        action: "upload",
        screenshot: "/tmp/upload.png",
        artifactPath: "/tmp/upload-bbox.json",
        elements: [],
        overflows: [overflow]
      }
    ];

    expect(findIntroducedAtStep(overflow, snapshots)).toMatchObject({
      stepIndex: 2,
      stepLabel: "Upload homework",
      action: "upload",
      screenshot: "/tmp/upload.png",
      artifactPath: "/tmp/upload-bbox.json"
    });
  });

  it("classifies critical profile controls as P1 and other overflows as review P2", () => {
    const sendOverflow: BBoxOverflow = {
      selector: "button[aria-label=\"Send\"]",
      ariaLabel: "Send",
      bbox: { x: 370, y: 700, width: 44, height: 44 },
      viewportWidth: 390,
      overflowLeft: 0,
      overflowRight: 24
    };
    const menuOverflow: BBoxOverflow = {
      selector: "nav[aria-label=\"Menu\"]",
      ariaLabel: "Menu",
      bbox: { x: -240, y: 0, width: 260, height: 844 },
      viewportWidth: 390,
      overflowLeft: 240,
      overflowRight: 0
    };

    const criticalControls = [
      { name: "send", ariaLabelIncludes: ["send"], textIncludes: ["send"] }
    ];

    expect(classifyBBoxOverflow(sendOverflow, criticalControls)).toEqual({
      critical: true,
      controlName: "send",
      severity: "P1",
      reviewOnly: false
    });
    expect(classifyBBoxOverflow(menuOverflow, criticalControls)).toEqual({
      critical: false,
      severity: "P2",
      reviewOnly: true
    });
  });

  it("defines upload timeline keyframes for transient media states", () => {
    expect(timelineEventNamesForStep({ action: "upload" })).toEqual([
      "before-step",
      "after-file-select",
      "uploading-100ms",
      "uploading-500ms",
      "uploading-1s",
      "ready-to-send"
    ]);
    expect(timelineEventNamesForStep({ action: "press" })).toEqual([
      "before-step",
      "after-send",
      "after-ai-started"
    ]);
  });

  it("writes per-step timeline manifests and contact sheets with screenshot, bbox, and dom artifacts", async () => {
    const timelineDir = await mkdtemp(join(tmpdir(), "dogfood-timeline-"));
    const event: TimelineEvent = {
      viewport: "mobile",
      journey: "homework-help",
      stepIndex: 2,
      stepLabel: "Try attaching homework evidence",
      action: "upload",
      event: "uploading-500ms",
      timestamp: "2026-07-02T00:00:00.000Z",
      elapsedMs: 500,
      screenshot: "/tmp/timeline/mobile/homework-help/02-upload/004-uploading-500ms.png",
      bboxPath: "/tmp/timeline/mobile/homework-help/02-upload/004-uploading-500ms-bbox.json",
      domPath: "/tmp/timeline/mobile/homework-help/02-upload/004-uploading-500ms-dom.json",
      domSummary: {
        chatInput: true,
        uploadAffordance: true,
        statusTexts: ["Uploading image"]
      },
      consoleSummary: { count: 0, latest: [] },
      networkSummary: { count: 0, latest: [] }
    };

    const contactSheetPath = await writeTimelineStepContactSheet(
      timelineDir,
      "mobile",
      "homework-help",
      1,
      { action: "upload", label: "Try attaching homework evidence" },
      [event]
    );
    const manifestPath = await writeTimelineStepManifest(
      timelineDir,
      "mobile",
      "homework-help",
      1,
      { action: "upload", label: "Try attaching homework evidence" },
      [event],
      contactSheetPath
    );
    await expect(stat(manifestPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(stat(contactSheetPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { events: TimelineEvent[]; contactSheet: string };
    const contactSheet = await readFile(contactSheetPath, "utf8");

    expect(manifest.contactSheet).toBe(contactSheetPath);
    expect(manifest.events[0]).toMatchObject({
      event: "uploading-500ms",
      screenshot: event.screenshot,
      bboxPath: event.bboxPath,
      domPath: event.domPath
    });
    expect(contactSheet).toContain("uploading-500ms");
    expect(contactSheet).toContain("004-uploading-500ms.png");
    expect(contactSheet).toContain("004-uploading-500ms-bbox.json");
    expect(contactSheet).toContain("004-uploading-500ms-dom.json");
  });
});
