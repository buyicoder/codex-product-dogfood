import { describe, expect, it } from "vitest";
import type { AuditReport, Finding } from "@codex-product-dogfood/schemas";
import { buildDevelopmentPlan, renderMarkdownReport, scoreMaturity } from "./index.js";

function finding(severity: Finding["severity"], title = `${severity} finding`): Finding {
  return {
    severity,
    title,
    journey: "first-run",
    viewport: "desktop",
    userSymptom: "User sees a problem.",
    expected: "The flow works.",
    actual: "The flow is broken.",
    introducedAtEvent: {
      viewport: "mobile",
      journey: "homework-help",
      stepIndex: 2,
      stepLabel: "Try attaching homework evidence",
      action: "upload",
      event: "uploading-500ms",
      elapsedMs: 500,
      screenshot: "/tmp/audit/timeline/mobile/homework-help/02-upload/004-uploading-500ms.png",
      bboxPath: "/tmp/audit/timeline/mobile/homework-help/02-upload/004-uploading-500ms-bbox.json",
      domPath: "/tmp/audit/timeline/mobile/homework-help/02-upload/004-uploading-500ms-dom.json",
      stateChainPath: "/tmp/audit/timeline/mobile/homework-help/02-upload/state-chain.json",
      domSummary: {
        statusTexts: ["Uploading image"],
        visibleImages: 1,
        imageSummaries: ["img[0] 80x60 natural=800x600 alt=\"homework\""],
        rawLatexMatches: 0,
        scrollWidth: 440,
        clientWidth: 390
      },
      consoleSummary: { count: 0, latest: [] },
      networkSummary: { count: 0, latest: [] }
    },
    evidence: [{ type: "screenshot", path: "/tmp/audit/screenshots/desktop.png", detail: "Final screenshot" }],
    reproSteps: ["Open page"],
    acceptanceCriteria: ["Flow works"]
  };
}

describe("reporter", () => {
  it("scores clean runs as strong", () => {
    expect(scoreMaturity([])).toMatchObject({ score: 100, releaseReadiness: "strong" });
  });

  it("blocks release when a P0 is present", () => {
    expect(scoreMaturity([finding("P0")])).toMatchObject({ score: 65, releaseReadiness: "blocked" });
  });

  it("sorts development plan items by severity", () => {
    expect(buildDevelopmentPlan([finding("P2"), finding("P0"), finding("P1")]).map((item) => item.priority)).toEqual(["P0", "P1", "P2"]);
  });

  it("renders a markdown report with summary and findings", () => {
    const report: AuditReport = {
      summary: {
        url: "https://example.com",
        profile: "ai-chat",
        generatedAt: "2026-07-01T00:00:00.000Z",
        viewports: ["desktop"],
        maturity: scoreMaturity([finding("P1", "Input missing")]),
        findingCounts: { P0: 0, P1: 1, P2: 0 }
      },
      findings: [finding("P1", "Input missing")],
      developmentPlan: buildDevelopmentPlan([finding("P1", "Input missing")])
    };

    expect(renderMarkdownReport("/tmp/audit", report)).toMatchSnapshot();
  });
});
