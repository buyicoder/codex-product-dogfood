import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { ProfileName, Severity, ViewportName } from "@codex-product-dogfood/schemas";

export type StepAction = "open" | "click" | "fill" | "press" | "upload" | "wait" | "observe" | "assertSignal";

export type TargetConfig =
  | { kind: "bestInput" }
  | { kind: "fileInput" }
  | { kind: "keyword"; values: string[] }
  | { kind: "text"; value: string }
  | { kind: "role"; role: string; name: string }
  | { kind: "placeholder"; value: string }
  | { kind: "css"; selector: string };

export interface JourneyStep {
  action: StepAction;
  label: string;
  target?: TargetConfig;
  query?: string[];
  text?: string;
  value?: string;
  key?: string;
  signal?: string;
  severity?: Severity;
  optional?: boolean;
  expectedSignals?: string[];
  failureSignals?: string[];
}

export interface AuditJourney {
  id: string;
  title: string;
  userGoal: string;
  steps: JourneyStep[];
}

export interface CriticalControlRule {
  name: string;
  selectorIncludes?: string[];
  role?: string[];
  textIncludes?: string[];
  ariaLabelIncludes?: string[];
}

export interface AuditProfile {
  name: string;
  description: string;
  testQuestion: string;
  viewports?: ViewportName[];
  primaryEntryKeywords: string[];
  expectedSignals: string[];
  failureSignals: string[];
  criticalControls: CriticalControlRule[];
  journeys: AuditJourney[];
}

export type ProfileConfig = Partial<Omit<AuditProfile, "journeys">> & {
  name: string;
  description: string;
  testQuestion: string;
  journeys: Array<{
    id: string;
    title: string;
    userGoal: string;
    steps: Array<Partial<JourneyStep> & { action: StepAction }>;
  }>;
};

const knownProfiles = ["ai-chat", "student-learning"] as const;
const actions = ["open", "click", "fill", "press", "upload", "wait", "observe", "assertSignal"] as const;
const viewportNames = ["desktop", "mobile", "small-mobile"] as const;

const sharedFailureSignals = [
  "error",
  "failed",
  "exception",
  "unhandled",
  "network error",
  "加载失败",
  "出错",
  "异常",
  "失败"
];

export const profiles: Record<ProfileName, AuditProfile> = {
  "ai-chat": normalizeProfile({
    name: "ai-chat",
    description: "A conversational AI product where users expect quick prompt entry, answer generation, upload, voice, and helpful empty/error states.",
    testQuestion: "Please explain photosynthesis in three bullet points and ask me one follow-up question.",
    primaryEntryKeywords: ["chat", "ask", "new", "start", "send", "开始", "提问", "聊天", "问"],
    expectedSignals: ["chatInput", "sendAction", "emptyState", "uploadAffordance", "voiceAffordance"],
    failureSignals: sharedFailureSignals,
    criticalControls: [
      { name: "composer", selectorIncludes: ["textarea", "input[type='text']", "[role=\"textbox\"]"] },
      { name: "status", role: ["status"], selectorIncludes: ["[role=\"status\"]"] },
      { name: "upload", selectorIncludes: ["input[type='file']"], textIncludes: ["upload", "attach", "上传", "附件"], ariaLabelIncludes: ["upload", "attach", "上传", "附件"] },
      { name: "voice", textIncludes: ["voice", "mic", "microphone", "语音", "麦克风"], ariaLabelIncludes: ["voice", "mic", "microphone", "语音", "麦克风"] },
      { name: "send", textIncludes: ["send", "submit", "发送", "提交"], ariaLabelIncludes: ["send", "submit", "发送", "提交"] }
    ],
    journeys: [
      {
        id: "first-prompt",
        title: "Ask the first question",
        userGoal: "A new user can find the input, ask a question, and see the product respond or clearly explain why it cannot.",
        steps: [
          { action: "open", label: "Open the target URL" },
          { action: "fill", label: "Enter a realistic first prompt", target: { kind: "bestInput" }, value: "{{testQuestion}}", expectedSignals: ["chatInput"] },
          { action: "press", label: "Submit with Enter", key: "Enter", expectedSignals: ["sendAction"] },
          { action: "observe", label: "Look for answer, loading, empty, or error state" }
        ]
      },
      {
        id: "multimodal-entry",
        title: "Try multimodal controls",
        userGoal: "A user can discover upload and voice controls without hunting.",
        steps: [
          { action: "open", label: "Open the target URL" },
          { action: "upload", label: "Try attaching a small file", target: { kind: "fileInput" }, optional: true, expectedSignals: ["uploadAffordance"] },
          { action: "click", label: "Look for voice input", target: { kind: "keyword", values: ["voice", "mic", "microphone", "语音", "麦克风"] }, optional: true, expectedSignals: ["voiceAffordance"] },
          { action: "observe", label: "Check multimodal affordances" }
        ]
      }
    ]
  }),
  "student-learning": normalizeProfile({
    name: "student-learning",
    description: "A student learning product where users expect learning entry points, practice input, formulas, upload, voice, clear empty states, and recoverable errors.",
    testQuestion: "Solve 2x + 5 = 17 step by step, then give me one similar practice problem.",
    primaryEntryKeywords: ["learn", "practice", "start", "question", "homework", "学习", "练习", "开始", "题目", "作业", "答疑"],
    expectedSignals: ["learningEntry", "chatInput", "formulaAffordance", "uploadAffordance", "voiceAffordance", "emptyState"],
    failureSignals: sharedFailureSignals,
    criticalControls: [
      { name: "composer", selectorIncludes: ["textarea", "input[type='text']", "[role=\"textbox\"]", "[contenteditable"] },
      { name: "status", role: ["status"], selectorIncludes: ["[role=\"status\"]", "[aria-live"] },
      { name: "upload", selectorIncludes: ["input[type='file']"], textIncludes: ["upload", "attach", "file", "上传", "附件", "拍照", "图片"], ariaLabelIncludes: ["upload", "attach", "file", "上传", "附件", "拍照", "图片"] },
      { name: "voice", textIncludes: ["voice", "mic", "microphone", "record", "语音", "麦克风", "录音"], ariaLabelIncludes: ["voice", "mic", "microphone", "record", "语音", "麦克风", "录音"] },
      { name: "send", textIncludes: ["send", "submit", "ask", "发送", "提交", "提问"], ariaLabelIncludes: ["send", "submit", "ask", "发送", "提交", "提问"] }
    ],
    journeys: [
      {
        id: "start-learning",
        title: "Start a learning session",
        userGoal: "A student can find where to begin learning or ask for help.",
        steps: [
          { action: "open", label: "Open the target URL" },
          { action: "click", label: "Click the most likely learning entry", target: { kind: "keyword", values: ["learn", "practice", "开始", "学习", "练习"] }, optional: true, expectedSignals: ["learningEntry"] },
          { action: "fill", label: "Enter a math learning question", target: { kind: "bestInput" }, value: "{{testQuestion}}", expectedSignals: ["chatInput", "formulaAffordance"] },
          { action: "press", label: "Submit with Enter", key: "Enter" },
          { action: "observe", label: "Observe learning response state" }
        ]
      },
      {
        id: "homework-help",
        title: "Try homework help affordances",
        userGoal: "A student can attach homework, speak a question, or type formulas.",
        steps: [
          { action: "open", label: "Open the target URL" },
          { action: "upload", label: "Try attaching homework evidence", target: { kind: "fileInput" }, optional: true, expectedSignals: ["uploadAffordance"] },
          { action: "click", label: "Look for voice input", target: { kind: "keyword", values: ["voice", "mic", "microphone", "语音", "麦克风"] }, optional: true, expectedSignals: ["voiceAffordance"] },
          { action: "observe", label: "Check for empty, disabled, or error states" }
        ]
      }
    ]
  })
};

export function getProfile(name: string): AuditProfile {
  if (!isProfileName(name)) {
    throw new Error(`Unknown profile "${name}". Expected ai-chat or student-learning.`);
  }
  return profiles[name];
}

export function listProfiles(): ProfileName[] {
  return [...knownProfiles];
}

export async function loadProfileFile(path: string): Promise<AuditProfile> {
  const raw = await readFile(path, "utf8");
  const parsed = parse(raw) as unknown;
  return normalizeProfile(parsed);
}

export function normalizeProfile(config: unknown): AuditProfile {
  if (!isObject(config)) {
    throw new Error("Profile config must be an object.");
  }
  const name = requireString(config, "name");
  const description = requireString(config, "description");
  const testQuestion = requireString(config, "testQuestion");
  const journeysRaw = getArray(config, "journeys");
  const seenJourneyIds = new Set<string>();
  const journeys: AuditJourney[] = journeysRaw.map((journeyRaw, journeyIndex) => {
    if (!isObject(journeyRaw)) {
      throw new Error(`journeys[${journeyIndex}] must be an object.`);
    }
    const id = requireString(journeyRaw, "id", `journeys[${journeyIndex}]`);
    if (seenJourneyIds.has(id)) {
      throw new Error(`Duplicate journey id "${id}".`);
    }
    seenJourneyIds.add(id);
    const stepsRaw = getArray(journeyRaw, "steps", `journeys[${journeyIndex}]`);
    return {
      id,
      title: requireString(journeyRaw, "title", `journeys[${journeyIndex}]`),
      userGoal: requireString(journeyRaw, "userGoal", `journeys[${journeyIndex}]`),
      steps: stepsRaw.map((stepRaw, stepIndex) => normalizeStep(stepRaw, `journeys[${journeyIndex}].steps[${stepIndex}]`))
    };
  });

  return {
    name,
    description,
    testQuestion,
    viewports: normalizeViewports(config.viewports),
    primaryEntryKeywords: normalizeStringArray(config.primaryEntryKeywords),
    expectedSignals: normalizeStringArray(config.expectedSignals),
    failureSignals: normalizeStringArray(config.failureSignals, sharedFailureSignals),
    criticalControls: normalizeCriticalControls(config.criticalControls),
    journeys
  };
}

function normalizeStep(stepRaw: unknown, path: string): JourneyStep {
  if (!isObject(stepRaw)) {
    throw new Error(`${path} must be an object.`);
  }
  const action = requireString(stepRaw, "action", path);
  if (!actions.includes(action as StepAction)) {
    throw new Error(`${path}.action "${action}" is not supported.`);
  }
  return {
    action: action as StepAction,
    label: typeof stepRaw.label === "string" ? stepRaw.label : action,
    target: normalizeTarget(stepRaw.target, path),
    query: normalizeStringArray(stepRaw.query),
    text: optionalString(stepRaw.text),
    value: optionalString(stepRaw.value),
    key: optionalString(stepRaw.key),
    signal: optionalString(stepRaw.signal),
    severity: normalizeSeverity(stepRaw.severity, path),
    optional: typeof stepRaw.optional === "boolean" ? stepRaw.optional : false,
    expectedSignals: normalizeStringArray(stepRaw.expectedSignals),
    failureSignals: normalizeStringArray(stepRaw.failureSignals)
  };
}

function normalizeTarget(targetRaw: unknown, path: string): TargetConfig | undefined {
  if (targetRaw === undefined) {
    return undefined;
  }
  if (!isObject(targetRaw)) {
    throw new Error(`${path}.target must be an object.`);
  }
  const kind = requireString(targetRaw, "kind", `${path}.target`);
  if (kind === "bestInput" || kind === "fileInput") {
    return { kind };
  }
  if (kind === "keyword") {
    return { kind, values: normalizeStringArray(targetRaw.values) };
  }
  if (kind === "text") {
    return { kind, value: requireString(targetRaw, "value", `${path}.target`) };
  }
  if (kind === "role") {
    return { kind, role: requireString(targetRaw, "role", `${path}.target`), name: requireString(targetRaw, "name", `${path}.target`) };
  }
  if (kind === "placeholder") {
    return { kind, value: requireString(targetRaw, "value", `${path}.target`) };
  }
  if (kind === "css") {
    return { kind, selector: requireString(targetRaw, "selector", `${path}.target`) };
  }
  throw new Error(`${path}.target.kind "${kind}" is not supported.`);
}

function normalizeViewports(value: unknown): ViewportName[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const items = normalizeStringArray(value);
  for (const item of items) {
    if (!viewportNames.includes(item as ViewportName)) {
      throw new Error(`Unsupported viewport "${item}".`);
    }
  }
  return items as ViewportName[];
}

function normalizeSeverity(value: unknown, path: string): Severity | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== "P0" && value !== "P1" && value !== "P2") {
    throw new Error(`${path}.severity must be P0, P1, or P2.`);
  }
  return value;
}

function normalizeCriticalControls(value: unknown): CriticalControlRule[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("profile.criticalControls must be an array.");
  }
  return value.map((item, index) => {
    if (!isObject(item)) {
      throw new Error(`profile.criticalControls[${index}] must be an object.`);
    }
    return {
      name: requireString(item, "name", `profile.criticalControls[${index}]`),
      selectorIncludes: normalizeOptionalStringArray(item.selectorIncludes, `profile.criticalControls[${index}].selectorIncludes`),
      role: normalizeOptionalStringArray(item.role, `profile.criticalControls[${index}].role`),
      textIncludes: normalizeOptionalStringArray(item.textIncludes, `profile.criticalControls[${index}].textIncludes`),
      ariaLabelIncludes: normalizeOptionalStringArray(item.ariaLabelIncludes, `profile.criticalControls[${index}].ariaLabelIncludes`)
    };
  });
}

function requireString(record: Record<string, unknown>, key: string, path = "profile"): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path}.${key} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getArray(record: Record<string, unknown>, key: string, path = "profile"): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`${path}.${key} must be an array.`);
  }
  return value;
}

function normalizeStringArray(value: unknown, fallback: string[] = []): string[] {
  if (value === undefined) {
    return [...fallback];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("Expected an array of strings.");
  }
  return [...value];
}

function normalizeOptionalStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${path} must be an array of strings.`);
  }
  return [...value];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProfileName(name: string): name is ProfileName {
  return knownProfiles.includes(name as ProfileName);
}
