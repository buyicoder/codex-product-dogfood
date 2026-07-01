import { describe, expect, it } from "vitest";
import { getProfile, listProfiles, normalizeProfile } from "./index.js";

describe("profiles", () => {
  it("loads built-in profiles", () => {
    expect(getProfile("ai-chat").name).toBe("ai-chat");
    expect(getProfile("student-learning").journeys.length).toBeGreaterThan(0);
  });

  it("lists built-in profile names", () => {
    expect(listProfiles()).toEqual(["ai-chat", "student-learning"]);
  });

  it("rejects unknown profile names", () => {
    expect(() => getProfile("unknown")).toThrow("Unknown profile");
  });

  it("normalizes a minimal profile config", () => {
    const profile = normalizeProfile({
      name: "custom",
      description: "Custom profile",
      testQuestion: "Question?",
      journeys: [
        {
          id: "first-run",
          title: "First run",
          userGoal: "Start",
          steps: [{ action: "open" }]
        }
      ]
    });

    expect(profile.primaryEntryKeywords).toEqual([]);
    expect(profile.failureSignals).toContain("error");
    expect(profile.journeys[0]?.steps[0]?.label).toBe("open");
  });
});
