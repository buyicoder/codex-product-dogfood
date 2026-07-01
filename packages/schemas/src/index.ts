export type Severity = "P0" | "P1" | "P2";

export type Confidence = "high" | "medium" | "low";

export type ViewportName = "desktop" | "mobile" | "small-mobile";

export type ProfileName = "ai-chat" | "student-learning";

export interface Evidence {
  type: "screenshot" | "console" | "network" | "dom" | "trace";
  path?: string;
  detail: string;
}

export interface Finding {
  id?: string;
  severity: Severity;
  confidence?: Confidence;
  title: string;
  journey: string;
  viewport: ViewportName;
  affectedViewports?: ViewportName[];
  tags?: string[];
  userSymptom: string;
  expected: string;
  actual: string;
  evidence: Evidence[];
  reproSteps: string[];
  acceptanceCriteria: string[];
}

export interface MaturityScore {
  score: number;
  releaseReadiness: "blocked" | "needs-work" | "usable" | "strong";
  rationale: string[];
}

export interface AuditSummary {
  url: string;
  profile: string;
  generatedAt: string;
  viewports: ViewportName[];
  maturity: MaturityScore;
  findingCounts: Record<Severity, number>;
}

export interface AuditReport {
  summary: AuditSummary;
  findings: Finding[];
  developmentPlan: DevelopmentPlanItem[];
}

export interface DevelopmentPlanItem {
  priority: Severity;
  title: string;
  rationale: string;
  acceptanceCriteria: string[];
}

export interface RuntimeSignal {
  viewport: ViewportName;
  journey?: string;
  consoleErrors: string[];
  networkFailures: string[];
  domSignals: Record<string, boolean | number | string | string[]>;
  screenshots: string[];
}

export function assertFindingShape(finding: Finding): void {
  const required = [
    "severity",
    "title",
    "journey",
    "viewport",
    "userSymptom",
    "expected",
    "actual",
    "evidence",
    "reproSteps",
    "acceptanceCriteria"
  ] as const;
  for (const key of required) {
    if (finding[key] === undefined || finding[key] === null) {
      throw new Error(`Invalid finding: missing ${key}`);
    }
  }
  if (!["P0", "P1", "P2"].includes(finding.severity)) {
    throw new Error(`Invalid finding severity: ${finding.severity}`);
  }
}

export function countFindings(findings: Finding[]): Record<Severity, number> {
  return {
    P0: findings.filter((finding) => finding.severity === "P0").length,
    P1: findings.filter((finding) => finding.severity === "P1").length,
    P2: findings.filter((finding) => finding.severity === "P2").length
  };
}
