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
