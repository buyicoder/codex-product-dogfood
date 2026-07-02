import { describe, expect, it } from "vitest";
import { detectBBoxOverflows, type BBoxElement } from "./index.js";

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
});
