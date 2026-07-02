import { describe, expect, it } from "vitest";
import { assertFindingShape, countFindings, type Finding } from "./index.js";

const validFinding: Finding = {
  severity: "P1",
  title: "Missing input",
  journey: "start",
  viewport: "desktop",
  userSymptom: "The user cannot type.",
  expected: "Input is visible.",
  actual: "Input is absent.",
  evidence: [{ type: "dom", detail: "No textbox found" }],
  reproSteps: ["Open the page"],
  acceptanceCriteria: ["Input is visible"]
};

describe("schemas", () => {
  it("validates a complete finding", () => {
    expect(() => assertFindingShape(validFinding)).not.toThrow();
  });

  it("allows optional introducedAtEvent metadata", () => {
    expect(() => assertFindingShape({
      ...validFinding,
      introducedAtEvent: {
        viewport: "mobile",
        journey: "homework-help",
        stepIndex: 2,
        stepLabel: "Upload homework",
        action: "upload",
        event: "uploading-500ms",
        elapsedMs: 500,
        screenshot: "/tmp/timeline/uploading-500ms.png",
        bboxPath: "/tmp/timeline/uploading-500ms-bbox.json",
        domPath: "/tmp/timeline/uploading-500ms-dom.json",
        stateChainPath: "/tmp/timeline/state-chain.json",
        domSummary: { visibleImages: 1, statusTexts: ["Uploading"] },
        consoleSummary: { count: 0, latest: [] },
        networkSummary: { count: 0, latest: [] }
      }
    })).not.toThrow();
  });

  it("rejects missing required finding fields", () => {
    expect(() => assertFindingShape({ ...validFinding, actual: undefined as unknown as string })).toThrow("missing actual");
  });

  it("rejects invalid severities", () => {
    expect(() => assertFindingShape({ ...validFinding, severity: "P4" as Finding["severity"] })).toThrow("Invalid finding severity");
  });

  it("counts findings by severity", () => {
    expect(countFindings([
      validFinding,
      { ...validFinding, severity: "P0" },
      { ...validFinding, severity: "P2" },
      { ...validFinding, severity: "P2" }
    ])).toEqual({ P0: 1, P1: 1, P2: 2 });
  });
});
