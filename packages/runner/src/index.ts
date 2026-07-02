import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { getProfile, loadProfileFile, type AuditJourney, type AuditProfile, type CriticalControlRule, type JourneyStep, type TargetConfig } from "@codex-product-dogfood/profiles";
import type { AuditReport, Finding, ProfileName, RuntimeSignal, Severity, ViewportName } from "@codex-product-dogfood/schemas";
import { assertFindingShape, countFindings } from "@codex-product-dogfood/schemas";
import { buildDevelopmentPlan, scoreMaturity, writeReport } from "@codex-product-dogfood/reporter";

export interface AuditOptions {
  url: string;
  profile?: string;
  profileFile?: string;
  outDir?: string;
  journey?: string;
  viewport?: ViewportName;
  headed?: boolean;
  timeoutMs?: number;
  keepExisting?: boolean;
}

interface StepResult {
  journey: string;
  step: string;
  action: string;
  status: "passed" | "failed" | "skipped";
  screenshot?: string;
  bboxSnapshot?: string;
  timelineManifest?: string;
  timelineContactSheet?: string;
  stateChain?: string;
  detail?: string;
}

interface RunMetadata {
  url: string;
  profile: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  viewports: ViewportName[];
  journey?: string;
  gitCommit?: string;
  toolVersion: string;
  steps: StepResult[];
}

export interface BBoxElement {
  selector: string;
  role?: string;
  text?: string;
  ariaLabel?: string;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface BBoxOverflow {
  selector: string;
  role?: string;
  text?: string;
  ariaLabel?: string;
  bbox: BBoxElement["bbox"];
  viewportWidth: number;
  overflowLeft: number;
  overflowRight: number;
}

export interface BBoxSnapshot {
  stepIndex: number;
  stepLabel: string;
  action: string;
  screenshot?: string;
  artifactPath?: string;
  elements: BBoxElement[];
  overflows: BBoxOverflow[];
}

export interface BBoxOverflowClassification {
  critical: boolean;
  controlName?: string;
  severity: Severity;
  reviewOnly: boolean;
}

export interface TimelineEvent {
  viewport: ViewportName;
  journey: string;
  stepIndex: number;
  stepLabel: string;
  action: string;
  event: string;
  timestamp: string;
  elapsedMs: number;
  screenshot: string;
  bboxPath: string;
  bboxOverflows: BBoxOverflow[];
  domPath: string;
  domSummary: Record<string, boolean | number | string | string[]>;
  consoleSummary: {
    count: number;
    latest: string[];
  };
  networkSummary: {
    count: number;
    latest: string[];
  };
}

export interface TimelineStepManifest {
  viewport: ViewportName;
  journey: string;
  stepIndex: number;
  stepLabel: string;
  action: string;
  events: TimelineEvent[];
  contactSheet?: string;
}

export interface StateChainFrame {
  viewport: ViewportName;
  journey: string;
  stepIndex: number;
  stepLabel: string;
  action: string;
  event: string;
  phase: "before" | "during" | "ready" | "after" | "persisted";
  timestamp: string;
  elapsedMs: number;
  screenshot: string;
  bboxPath: string;
  domPath: string;
  bboxOverflowCount: number;
  statusTexts: string[];
  visibleImages: number;
  rawLatexMatches: number;
  scrollWidth?: number;
  clientWidth?: number;
  consoleCount: number;
  networkFailureCount: number;
}

export interface StateChainManifest {
  viewport: ViewportName;
  journey: string;
  stepIndex: number;
  stepLabel: string;
  action: string;
  contactSheet?: string;
  firstBadFrame?: StateChainFrame;
  lastGoodFrame?: StateChainFrame;
  stateSummary: {
    frameCount: number;
    maxVisibleImages: number;
    statusTexts: string[];
    maxBBoxOverflowCount: number;
    maxRawLatexMatches: number;
  };
  frames: StateChainFrame[];
}

const execFileAsync = promisify(execFile);

const viewports: Record<ViewportName, { width: number; height: number; isMobile?: boolean }> = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844, isMobile: true },
  "small-mobile": { width: 375, height: 667, isMobile: true }
};

export async function runAudit(options: AuditOptions): Promise<AuditReport> {
  const startedAtMs = Date.now();
  const profile = await resolveProfile(options);
  const selectedViewports = selectViewports(profile, options.viewport);
  const selectedJourneys = selectJourneys(profile, options.journey);
  const outDir = resolve(options.outDir ?? "runtime/audits/latest");
  const screenshotsDir = join(outDir, "screenshots");
  const domDir = join(outDir, "dom");
  const timelineDir = join(outDir, "timeline");
  if (!options.keepExisting) {
    await rm(outDir, { recursive: true, force: true });
  }
  await mkdir(screenshotsDir, { recursive: true });
  await mkdir(domDir, { recursive: true });
  await mkdir(timelineDir, { recursive: true });
  await writeFile(join(outDir, "sample-upload.txt"), "Codex Product Dogfood sample upload.\n");

  const run: RunMetadata = {
    url: options.url,
    profile: profile.name,
    startedAt: new Date(startedAtMs).toISOString(),
    viewports: selectedViewports,
    journey: options.journey,
    gitCommit: await currentGitCommit(),
    toolVersion: "0.1.0",
    steps: []
  };

  const browser = await chromium.launch({ headless: !options.headed });
  const findings: Finding[] = [];
  const signals: RuntimeSignal[] = [];
  const timelineEvents: TimelineEvent[] = [];
  try {
    for (const viewportName of selectedViewports) {
      const viewportResult = await auditViewport(browser, profile, selectedJourneys, options.url, viewportName, screenshotsDir, domDir, timelineDir, outDir, options.timeoutMs ?? 15000);
      findings.push(...viewportResult.findings);
      signals.push(...viewportResult.signals);
      run.steps.push(...viewportResult.steps);
      timelineEvents.push(...viewportResult.timelineEvents);
    }
  } finally {
    await browser.close();
  }

  enrichFindings(findings);
  const maturity = scoreMaturity(findings);
  const report: AuditReport = {
    summary: {
      url: options.url,
      profile: profile.name,
      generatedAt: new Date().toISOString(),
      viewports: selectedViewports,
      maturity,
      findingCounts: countFindings(findings)
    },
    findings,
    developmentPlan: buildDevelopmentPlan(findings)
  };
  for (const finding of findings) {
    assertFindingShape(finding);
  }
  run.finishedAt = new Date().toISOString();
  run.durationMs = Date.now() - startedAtMs;
  await writeFile(join(outDir, "signals.json"), `${JSON.stringify(signals, null, 2)}\n`);
  await writeFile(join(outDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  await writeFile(join(outDir, "timeline.json"), `${JSON.stringify({ events: timelineEvents }, null, 2)}\n`);
  await writeFile(join(timelineDir, "manifest.json"), `${JSON.stringify({ events: timelineEvents }, null, 2)}\n`);
  await writeTimelineContactSheetIndex(timelineDir, timelineEvents);
  await writeReport(outDir, report);
  return report;
}

async function resolveProfile(options: AuditOptions): Promise<AuditProfile> {
  if (options.profileFile) {
    return loadProfileFile(options.profileFile);
  }
  return getProfile(options.profile ?? "ai-chat");
}

function selectViewports(profile: AuditProfile, viewport?: ViewportName): ViewportName[] {
  if (viewport) {
    return [viewport];
  }
  return profile.viewports?.length ? profile.viewports : (Object.keys(viewports) as ViewportName[]);
}

function selectJourneys(profile: AuditProfile, journeyId?: string): AuditJourney[] {
  if (!journeyId) {
    return profile.journeys;
  }
  const journey = profile.journeys.find((candidate) => candidate.id === journeyId);
  if (!journey) {
    throw new Error(`Unknown journey "${journeyId}" for profile "${profile.name}".`);
  }
  return [journey];
}

async function auditViewport(
  browser: Browser,
  profile: AuditProfile,
  journeys: AuditJourney[],
  url: string,
  viewportName: ViewportName,
  screenshotsDir: string,
  domDir: string,
  timelineDir: string,
  outDir: string,
  timeoutMs: number
): Promise<{ findings: Finding[]; signals: RuntimeSignal[]; steps: StepResult[]; timelineEvents: TimelineEvent[] }> {
  const context = await browser.newContext({
    viewport: viewports[viewportName],
    isMobile: viewports[viewportName].isMobile ?? false
  });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const networkFailures: string[] = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      consoleErrors.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("requestfailed", (request) => {
    networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`);
  });

  const findings: Finding[] = [];
  const signals: RuntimeSignal[] = [];
  const steps: StepResult[] = [];
  const timelineEvents: TimelineEvent[] = [];
  try {
    for (const journey of journeys) {
      const journeyResult = await executeJourney(page, profile, journey, url, viewportName, screenshotsDir, domDir, timelineDir, outDir, timeoutMs, consoleErrors, networkFailures);
      findings.push(...journeyResult.findings);
      signals.push(journeyResult.signal);
      steps.push(...journeyResult.steps);
      timelineEvents.push(...journeyResult.timelineEvents);
    }
  } finally {
    await context.close();
  }
  return { findings, signals, steps, timelineEvents };
}

async function executeJourney(
  page: Page,
  profile: AuditProfile,
  journey: AuditJourney,
  url: string,
  viewportName: ViewportName,
  screenshotsDir: string,
  domDir: string,
  timelineDir: string,
  outDir: string,
  timeoutMs: number,
  consoleErrors: string[],
  networkFailures: string[]
): Promise<{ findings: Finding[]; signal: RuntimeSignal; steps: StepResult[]; timelineEvents: TimelineEvent[] }> {
  const screenshots: string[] = [];
  const bboxSnapshots: BBoxSnapshot[] = [];
  const findings: Finding[] = [];
  const steps: StepResult[] = [];
  const timelineEvents: TimelineEvent[] = [];
  const reproBase = [
    `Open ${url}`,
    `Use ${viewportName} viewport (${viewports[viewportName].width}x${viewports[viewportName].height})`,
    `Run ${profile.name}/${journey.id}`
  ];
  let opened = false;

  for (const [index, step] of journey.steps.entries()) {
    if (!opened && step.action !== "open") {
      const openResult = await openPage(page, url, timeoutMs);
      opened = openResult.ok;
      if (!openResult.ok) {
        const screenshot = await screenshotPage(page, screenshotsDir, viewportName, journey.id, index, "navigation-failure");
        screenshots.push(screenshot);
        findings.push(navigationFinding(url, viewportName, journey.id, openResult.detail, screenshot, reproBase));
        steps.push({ journey: journey.id, step: "implicit-open", action: "open", status: "failed", screenshot, detail: openResult.detail });
        break;
      }
    }

    const stepTimelineEvents: TimelineEvent[] = [];
    stepTimelineEvents.push(await captureTimelineEvent(page, profile, timelineDir, viewportName, journey.id, index, step, "before-step", consoleErrors, networkFailures));
    const result = await executeStep(page, profile, step, url, outDir, timeoutMs);
    stepTimelineEvents.push(...await capturePostStepTimeline(page, profile, step, timelineDir, viewportName, journey.id, index, consoleErrors, networkFailures));
    timelineEvents.push(...stepTimelineEvents);
    const timelineContactSheet = await writeTimelineStepContactSheet(timelineDir, viewportName, journey.id, index, step, stepTimelineEvents);
    const timelineManifest = await writeTimelineStepManifest(timelineDir, viewportName, journey.id, index, step, stepTimelineEvents, timelineContactSheet);
    const stateChain = await writeStateChainManifest(timelineDir, viewportName, journey.id, index, step, stepTimelineEvents, timelineContactSheet);
    if (step.action === "open" && result.status === "passed") {
      opened = true;
    }
    const screenshot = await screenshotPage(page, screenshotsDir, viewportName, journey.id, index, step.action);
    screenshots.push(screenshot);
    const bboxSnapshot = await captureBBoxSnapshot(page, domDir, viewportName, journey.id, index, step, screenshot);
    bboxSnapshots.push(bboxSnapshot);
    steps.push({ journey: journey.id, step: step.label, action: step.action, status: result.status, screenshot, bboxSnapshot: bboxSnapshot.artifactPath, timelineManifest, timelineContactSheet, stateChain, detail: result.detail });
    if (result.status === "failed") {
      findings.push(stepFailureFinding(profile, journey, step, viewportName, result.detail, screenshot, reproBase));
    }
  }

  const domSignals = await collectDomSignals(page, profile);
  const bboxElements = await collectBBoxElements(page);
  const bboxOverflows = detectBBoxOverflows(bboxElements, viewports[viewportName].width);
  await writeFile(join(domDir, `${viewportName}-${journey.id}.json`), `${JSON.stringify(domSignals, null, 2)}\n`);
  await writeFile(join(domDir, `${viewportName}-${journey.id}-bbox.json`), `${JSON.stringify({ viewportWidth: viewports[viewportName].width, elements: bboxElements, overflows: bboxOverflows, stepSnapshots: bboxSnapshots }, null, 2)}\n`);
  domSignals.bboxOverflowCount = bboxOverflows.length;
  const expectedSignals = Array.from(new Set([...profile.expectedSignals, ...journey.steps.flatMap((step) => step.expectedSignals ?? [])]));
  findings.push(...buildSignalFindings(profile, journey.id, viewportName, expectedSignals, domSignals, screenshots, reproBase));
  findings.push(...buildBBoxOverflowFindings(profile, journey.id, viewportName, bboxOverflows, bboxSnapshots, timelineEvents, screenshots, reproBase));
  findings.push(...buildRuntimeFindings(viewportName, journey.id, consoleErrors, networkFailures, screenshots, reproBase));

  return {
    findings,
    signal: { viewport: viewportName, journey: journey.id, consoleErrors: [...consoleErrors], networkFailures: [...networkFailures], domSignals, screenshots },
    steps,
    timelineEvents
  };
}

async function executeStep(
  page: Page,
  profile: AuditProfile,
  step: JourneyStep,
  url: string,
  outDir: string,
  timeoutMs: number
): Promise<{ status: StepResult["status"]; detail?: string }> {
  try {
    if (step.action === "open") {
      const result = await openPage(page, url, timeoutMs);
      return { status: result.ok ? "passed" : "failed", detail: result.detail };
    }
    if (step.action === "click") {
      const clicked = await clickTarget(page, step.target, step.query ?? profile.primaryEntryKeywords);
      return clicked ? { status: "passed" } : step.optional ? { status: "skipped", detail: "Optional click target not found." } : { status: "failed", detail: "Click target not found." };
    }
    if (step.action === "fill") {
      const value = renderTemplate(step.value ?? step.text ?? profile.testQuestion, profile);
      const filled = await fillTarget(page, step.target ?? { kind: "bestInput" }, value);
      return filled ? { status: "passed" } : step.optional ? { status: "skipped", detail: "Optional fill target not found." } : { status: "failed", detail: "Fill target not found." };
    }
    if (step.action === "press") {
      await page.keyboard.press(step.key ?? "Enter");
      await page.waitForTimeout(1000);
      return { status: "passed" };
    }
    if (step.action === "upload") {
      const uploaded = await uploadTarget(page, step.target ?? { kind: "fileInput" }, join(outDir, "sample-upload.txt"));
      return uploaded ? { status: "passed" } : step.optional ? { status: "skipped", detail: "Optional file input not found." } : { status: "failed", detail: "File input not found." };
    }
    if (step.action === "wait" || step.action === "observe") {
      await page.waitForTimeout(step.action === "wait" ? 1000 : 1500);
      return { status: "passed" };
    }
    if (step.action === "assertSignal") {
      const signals = await collectDomSignals(page, profile);
      const signal = step.signal ?? step.expectedSignals?.[0];
      const passed = signal ? Boolean(signals[signal]) : false;
      return passed ? { status: "passed" } : { status: step.optional ? "skipped" : "failed", detail: `Signal "${signal ?? "unknown"}" was not detected.` };
    }
    return { status: "failed", detail: `Unsupported action "${step.action}".` };
  } catch (error) {
    if (step.optional) {
      return { status: "skipped", detail: error instanceof Error ? error.message : String(error) };
    }
    return { status: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function openPage(page: Page, url: string, timeoutMs: number): Promise<{ ok: boolean; detail?: string }> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 8000) }).catch(() => undefined);
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function screenshotPage(page: Page, screenshotsDir: string, viewportName: ViewportName, journey: string, index: number, action: string): Promise<string> {
  const directory = join(screenshotsDir, viewportName, journey);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${String(index + 1).padStart(2, "0")}-${slug(action)}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

async function captureBBoxSnapshot(
  page: Page,
  domDir: string,
  viewportName: ViewportName,
  journey: string,
  index: number,
  step: JourneyStep,
  screenshot: string
): Promise<BBoxSnapshot> {
  const elements = await collectBBoxElements(page);
  const overflows = detectBBoxOverflows(elements, viewports[viewportName].width);
  const artifactPath = join(domDir, `${viewportName}-${journey}-${String(index + 1).padStart(2, "0")}-${slug(step.action)}-bbox.json`);
  const snapshot: BBoxSnapshot = {
    stepIndex: index + 1,
    stepLabel: step.label,
    action: step.action,
    screenshot,
    artifactPath,
    elements,
    overflows
  };
  await writeFile(artifactPath, `${JSON.stringify({ viewportWidth: viewports[viewportName].width, ...snapshot }, null, 2)}\n`);
  return snapshot;
}

async function capturePostStepTimeline(
  page: Page,
  profile: AuditProfile,
  step: JourneyStep,
  timelineDir: string,
  viewportName: ViewportName,
  journey: string,
  index: number,
  consoleErrors: string[],
  networkFailures: string[]
): Promise<TimelineEvent[]> {
  const events: TimelineEvent[] = [];
  for (const event of timelineEventNamesForStep(step).slice(1)) {
    await waitBeforeTimelineEvent(page, event);
    events.push(await captureTimelineEvent(page, profile, timelineDir, viewportName, journey, index, step, event, consoleErrors, networkFailures));
  }
  return events;
}

async function captureTimelineEvent(
  page: Page,
  profile: AuditProfile,
  timelineDir: string,
  viewportName: ViewportName,
  journey: string,
  index: number,
  step: JourneyStep,
  event: string,
  consoleErrors: string[],
  networkFailures: string[]
): Promise<TimelineEvent> {
  const directory = join(timelineDir, viewportName, journey, `${String(index + 1).padStart(2, "0")}-${slug(step.action)}`);
  await mkdir(directory, { recursive: true });
  const prefix = `${String(eventOrder(event)).padStart(3, "0")}-${slug(event)}`;
  const screenshot = join(directory, `${prefix}.png`);
  const bboxPath = join(directory, `${prefix}-bbox.json`);
  const domPath = join(directory, `${prefix}-dom.json`);
  await page.screenshot({ path: screenshot, fullPage: true });
  const bboxElements = await collectBBoxElements(page);
  const bboxOverflows = detectBBoxOverflows(bboxElements, viewports[viewportName].width);
  const domSummary = await collectTimelineDomSummary(page, profile);
  await writeFile(bboxPath, `${JSON.stringify({ viewportWidth: viewports[viewportName].width, elements: bboxElements, overflows: bboxOverflows }, null, 2)}\n`);
  await writeFile(domPath, `${JSON.stringify(domSummary, null, 2)}\n`);
  return {
    viewport: viewportName,
    journey,
    stepIndex: index + 1,
    stepLabel: step.label,
    action: step.action,
    event,
    timestamp: new Date().toISOString(),
    elapsedMs: eventElapsedMs(event),
    screenshot,
    bboxPath,
    bboxOverflows,
    domPath,
    domSummary,
    consoleSummary: {
      count: consoleErrors.length,
      latest: consoleErrors.slice(-5)
    },
    networkSummary: {
      count: networkFailures.length,
      latest: networkFailures.slice(-5)
    }
  };
}

export async function writeTimelineStepManifest(
  timelineDir: string,
  viewportName: ViewportName,
  journey: string,
  index: number,
  step: JourneyStep,
  events: TimelineEvent[],
  contactSheet?: string
): Promise<string> {
  const directory = join(timelineDir, viewportName, journey, `${String(index + 1).padStart(2, "0")}-${slug(step.action)}`);
  await mkdir(directory, { recursive: true });
  const manifestPath = join(directory, "manifest.json");
  const manifest: TimelineStepManifest = {
    viewport: viewportName,
    journey,
    stepIndex: index + 1,
    stepLabel: step.label,
    action: step.action,
    events,
    contactSheet
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

export async function writeTimelineStepContactSheet(
  timelineDir: string,
  viewportName: ViewportName,
  journey: string,
  index: number,
  step: JourneyStep,
  events: TimelineEvent[]
): Promise<string> {
  const directory = join(timelineDir, viewportName, journey, `${String(index + 1).padStart(2, "0")}-${slug(step.action)}`);
  await mkdir(directory, { recursive: true });
  const contactSheetPath = join(directory, "contact-sheet.html");
  const title = `${viewportName} / ${journey} / ${index + 1}. ${step.label}`;
  await writeFile(contactSheetPath, renderContactSheetHtml(title, events, contactSheetPath));
  return contactSheetPath;
}

export async function writeStateChainManifest(
  timelineDir: string,
  viewportName: ViewportName,
  journey: string,
  index: number,
  step: JourneyStep,
  events: TimelineEvent[],
  contactSheet?: string
): Promise<string> {
  const directory = join(timelineDir, viewportName, journey, `${String(index + 1).padStart(2, "0")}-${slug(step.action)}`);
  await mkdir(directory, { recursive: true });
  const stateChainPath = join(directory, "state-chain.json");
  const manifest = buildStateChainManifest(viewportName, journey, index, step, events, contactSheet);
  await writeFile(stateChainPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return stateChainPath;
}

export function buildStateChainManifest(
  viewportName: ViewportName,
  journey: string,
  index: number,
  step: Pick<JourneyStep, "action" | "label">,
  events: TimelineEvent[],
  contactSheet?: string
): StateChainManifest {
  const frames = events.map((event) => timelineEventToStateChainFrame(event));
  const firstBadFrame = frames.find((frame) => frame.bboxOverflowCount > 0);
  const lastGoodFrame = firstBadFrame
    ? frames.slice(0, frames.indexOf(firstBadFrame)).reverse().find((frame) => frame.bboxOverflowCount === 0)
    : frames.at(-1);
  const statusTexts = Array.from(new Set(frames.flatMap((frame) => frame.statusTexts)));
  return {
    viewport: viewportName,
    journey,
    stepIndex: index + 1,
    stepLabel: step.label,
    action: step.action,
    contactSheet,
    firstBadFrame,
    lastGoodFrame,
    stateSummary: {
      frameCount: frames.length,
      maxVisibleImages: Math.max(0, ...frames.map((frame) => frame.visibleImages)),
      statusTexts,
      maxBBoxOverflowCount: Math.max(0, ...frames.map((frame) => frame.bboxOverflowCount)),
      maxRawLatexMatches: Math.max(0, ...frames.map((frame) => frame.rawLatexMatches))
    },
    frames
  };
}

function timelineEventToStateChainFrame(event: TimelineEvent): StateChainFrame {
  return {
    viewport: event.viewport,
    journey: event.journey,
    stepIndex: event.stepIndex,
    stepLabel: event.stepLabel,
    action: event.action,
    event: event.event,
    phase: statePhaseForEvent(event.event),
    timestamp: event.timestamp,
    elapsedMs: event.elapsedMs,
    screenshot: event.screenshot,
    bboxPath: event.bboxPath,
    domPath: event.domPath,
    bboxOverflowCount: event.bboxOverflows.length,
    statusTexts: Array.isArray(event.domSummary.statusTexts) ? event.domSummary.statusTexts : [],
    visibleImages: typeof event.domSummary.visibleImages === "number" ? event.domSummary.visibleImages : 0,
    rawLatexMatches: typeof event.domSummary.rawLatexMatches === "number" ? event.domSummary.rawLatexMatches : 0,
    scrollWidth: typeof event.domSummary.scrollWidth === "number" ? event.domSummary.scrollWidth : undefined,
    clientWidth: typeof event.domSummary.clientWidth === "number" ? event.domSummary.clientWidth : undefined,
    consoleCount: event.consoleSummary.count,
    networkFailureCount: event.networkSummary.count
  };
}

function statePhaseForEvent(event: string): StateChainFrame["phase"] {
  if (event === "before-step") {
    return "before";
  }
  if (event.startsWith("uploading") || event === "after-click" || event === "after-file-select" || event === "after-ai-started") {
    return "during";
  }
  if (event === "ready-to-send") {
    return "ready";
  }
  if (event === "after-send" || event === "after-step") {
    return "after";
  }
  return "persisted";
}

async function writeTimelineContactSheetIndex(timelineDir: string, events: TimelineEvent[]): Promise<string> {
  const grouped = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    const key = `${event.viewport}/${event.journey}/${String(event.stepIndex).padStart(2, "0")}-${slug(event.action)}`;
    grouped.set(key, [...(grouped.get(key) ?? []), event]);
  }
  const sections = Array.from(grouped.entries()).map(([key, stepEvents]) => {
    const first = stepEvents[0];
    const title = first ? `${first.viewport} / ${first.journey} / ${first.stepIndex}. ${first.stepLabel}` : key;
    const contactSheet = first ? join(timelineDir, first.viewport, first.journey, `${String(first.stepIndex).padStart(2, "0")}-${slug(first.action)}`, "contact-sheet.html") : undefined;
    return { key, title, events: stepEvents, contactSheet };
  });
  const indexPath = join(timelineDir, "contact-sheet.html");
  await writeFile(indexPath, renderContactSheetIndexHtml("Timeline Contact Sheets", sections, indexPath));
  return indexPath;
}

function renderContactSheetHtml(title: string, events: TimelineEvent[], currentPath: string): string {
  const firstBadFrameIndex = events.findIndex((event) => event.bboxOverflows.length > 0);
  const cards = events.map((event, index) => {
    const screenshot = relative(dirname(currentPath), event.screenshot);
    const bbox = relative(dirname(currentPath), event.bboxPath);
    const dom = relative(dirname(currentPath), event.domPath);
    const statusTexts = Array.isArray(event.domSummary.statusTexts) ? event.domSummary.statusTexts.slice(0, 3).join(" | ") : "";
    const imageSummaries = Array.isArray(event.domSummary.imageSummaries) ? event.domSummary.imageSummaries.slice(0, 3).join(" | ") : "";
    const attachmentSummaries = Array.isArray(event.domSummary.attachmentSummaries) ? event.domSummary.attachmentSummaries.slice(0, 3).join(" | ") : "";
    const scrollSummary = typeof event.domSummary.scrollWidth === "number" && typeof event.domSummary.clientWidth === "number"
      ? `${event.domSummary.scrollWidth}/${event.domSummary.clientWidth}`
      : "";
    const overflowSummary = event.bboxOverflows.slice(0, 3)
      .map((overflow) => `${overflow.selector} left=${overflow.overflowLeft} right=${overflow.overflowRight}`)
      .join(" | ");
    const firstBadFrame = index === firstBadFrameIndex;
    return `      <article class="frame">
        ${firstBadFrame ? `<div class="badge">FIRST BAD FRAME</div>` : ""}
        <a href="${escapeHtml(screenshot)}"><img src="${escapeHtml(screenshot)}" alt="${escapeHtml(event.event)} screenshot"></a>
        <h2>${escapeHtml(event.event)}${event.elapsedMs ? ` ${event.elapsedMs}ms` : ""}</h2>
        <p>${escapeHtml(event.timestamp)}${event.elapsedMs ? ` &middot; ${event.elapsedMs}ms` : ""}</p>
        <p>Console: ${event.consoleSummary.count} &middot; Network: ${event.networkSummary.count}</p>
        ${statusTexts ? `<p>Status: ${escapeHtml(statusTexts)}</p>` : ""}
        <p>Images: ${event.domSummary.visibleImages ?? 0}${imageSummaries ? ` (${escapeHtml(imageSummaries)})` : ""}</p>
        ${attachmentSummaries ? `<p>Attachments: ${escapeHtml(attachmentSummaries)}</p>` : ""}
        ${scrollSummary ? `<p>Scroll/client width: ${escapeHtml(scrollSummary)}</p>` : ""}
        ${overflowSummary ? `<p>Overflow: ${escapeHtml(overflowSummary)}</p>` : ""}
        <p><a href="${escapeHtml(bbox)}">bbox</a> &middot; <a href="${escapeHtml(dom)}">dom</a></p>
      </article>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 24px; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17202a; background: #f7f8fa; }
    h1 { margin: 0 0 16px; font-size: 22px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; align-items: start; }
    .frame { background: white; border: 1px solid #d8dee4; border-radius: 8px; padding: 12px; }
    .badge { display: inline-block; margin: 0 0 8px; padding: 4px 8px; border-radius: 999px; background: #b42318; color: white; font-weight: 700; font-size: 12px; }
    img { display: block; width: 100%; max-height: 420px; object-fit: contain; background: #eef1f4; border: 1px solid #d8dee4; border-radius: 6px; }
    h2 { margin: 10px 0 4px; font-size: 15px; }
    p { margin: 4px 0; color: #46515c; overflow-wrap: anywhere; }
    a { color: #0969da; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <main class="grid">
${cards}
  </main>
</body>
</html>
`;
}

function renderContactSheetIndexHtml(
  title: string,
  sections: Array<{ key: string; title: string; events: TimelineEvent[]; contactSheet?: string }>,
  currentPath: string
): string {
  const items = sections.map((section) => {
    const contactSheet = section.contactSheet ? relative(dirname(currentPath), section.contactSheet) : undefined;
    const preview = section.events[0] ? relative(dirname(currentPath), section.events[0].screenshot) : undefined;
    return `      <article class="step">
        ${preview ? `<a href="${escapeHtml(contactSheet ?? preview)}"><img src="${escapeHtml(preview)}" alt="${escapeHtml(section.title)} preview"></a>` : ""}
        <h2>${contactSheet ? `<a href="${escapeHtml(contactSheet)}">${escapeHtml(section.title)}</a>` : escapeHtml(section.title)}</h2>
        <p>${section.events.length} timeline events</p>
        <p>${escapeHtml(section.events.map((event) => event.event).join(" -> "))}</p>
      </article>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 24px; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17202a; background: #f7f8fa; }
    h1 { margin: 0 0 16px; font-size: 22px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; align-items: start; }
    .step { background: white; border: 1px solid #d8dee4; border-radius: 8px; padding: 12px; }
    img { display: block; width: 100%; max-height: 220px; object-fit: contain; background: #eef1f4; border: 1px solid #d8dee4; border-radius: 6px; }
    h2 { margin: 10px 0 4px; font-size: 15px; }
    p { margin: 4px 0; color: #46515c; overflow-wrap: anywhere; }
    a { color: #0969da; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <main class="grid">
${items}
  </main>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function timelineEventNamesForStep(step: Pick<JourneyStep, "action">): string[] {
  if (step.action === "click") {
    return ["before-step", "after-click"];
  }
  if (step.action === "upload") {
    return ["before-step", "after-file-select", "uploading-100ms", "uploading-500ms", "uploading-1s", "ready-to-send"];
  }
  if (step.action === "press") {
    return ["before-step", "after-send", "after-ai-started"];
  }
  return ["before-step", "after-step"];
}

async function waitBeforeTimelineEvent(page: Page, event: string): Promise<void> {
  if (event === "uploading-100ms") {
    await page.waitForTimeout(100);
  } else if (event === "uploading-500ms") {
    await page.waitForTimeout(400);
  } else if (event === "uploading-1s") {
    await page.waitForTimeout(500);
  } else if (event === "ready-to-send") {
    await page.waitForTimeout(250);
  } else if (event === "after-ai-started") {
    await page.waitForTimeout(500);
  }
}

async function collectTimelineDomSummary(page: Page, profile: AuditProfile): Promise<Record<string, boolean | number | string | string[]>> {
  const domSignals = await collectDomSignals(page, profile);
  const statusSummary = await page.evaluate(() => {
    const statusTexts = Array.from(document.querySelectorAll("[role='status'], [aria-live]"))
      .map((element) => (element.textContent ?? "").trim().replace(/\s+/g, " "))
      .filter(Boolean)
      .slice(0, 10);
    const visibleImageElements = Array.from(document.querySelectorAll("img"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      });
    const imageSummaries = visibleImageElements.map((element, index) => {
      const rect = element.getBoundingClientRect();
      return `img[${index}] ${Math.round(rect.width)}x${Math.round(rect.height)} natural=${element.naturalWidth}x${element.naturalHeight} alt="${(element.alt ?? "").slice(0, 40)}"`;
    }).slice(0, 10);
    const attachmentSummaries = Array.from(document.querySelectorAll("[data-attachment], [data-testid*='attachment' i], [class*='attachment' i], [class*='upload' i], [class*='image' i], [aria-label*='attachment' i], [aria-label*='upload' i], [aria-label*='image' i]"))
      .map((element, index) => {
        const rect = element.getBoundingClientRect();
        const text = (element.textContent ?? element.getAttribute("aria-label") ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
        return `attachment[${index}] ${element.tagName.toLowerCase()} ${Math.round(rect.width)}x${Math.round(rect.height)} "${text}"`;
      })
      .filter(Boolean)
      .slice(0, 10);
    const rawLatexMatches = (document.body.innerText.match(/\\(?:frac|sqrt|begin|end)|\$\$/g) ?? []).length;
    return {
      url: window.location.href,
      statusTexts,
      visibleImages: visibleImageElements.length,
      imageSummaries,
      attachmentSummaries,
      rawLatexMatches,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    };
  });
  return { ...domSignals, ...statusSummary };
}

function eventOrder(event: string): number {
  const order: Record<string, number> = {
    "before-step": 0,
    "after-click": 1,
    "after-file-select": 2,
    "uploading-100ms": 3,
    "uploading-500ms": 4,
    "uploading-1s": 5,
    "ready-to-send": 6,
    "after-send": 7,
    "after-ai-started": 8,
    "after-step": 9
  };
  return order[event] ?? 99;
}

function eventElapsedMs(event: string): number {
  if (event === "uploading-100ms") {
    return 100;
  }
  if (event === "uploading-500ms") {
    return 500;
  }
  if (event === "uploading-1s") {
    return 1000;
  }
  return 0;
}

async function clickTarget(page: Page, target: TargetConfig | undefined, fallbackKeywords: string[]): Promise<boolean> {
  if (!target || target.kind === "keyword") {
    return clickByKeywords(page, target?.values ?? fallbackKeywords);
  }
  const locator = locatorForTarget(page, target);
  return clickLocator(locator);
}

async function clickByKeywords(page: Page, keywords: string[]): Promise<boolean> {
  for (const keyword of keywords) {
    const button = page.getByRole("button", { name: new RegExp(keyword, "i") }).first();
    if (await clickLocator(button)) {
      return true;
    }
    const link = page.getByRole("link", { name: new RegExp(keyword, "i") }).first();
    if (await clickLocator(link)) {
      return true;
    }
    const text = page.getByText(new RegExp(keyword, "i")).first();
    if (await clickLocator(text)) {
      return true;
    }
  }
  const firstVisible = page.locator("button:visible, a:visible").first();
  return clickLocator(firstVisible);
}

async function clickLocator(locator: Locator): Promise<boolean> {
  if (!(await locator.count().catch(() => 0))) {
    return false;
  }
  return locator.click({ timeout: 1500 }).then(() => true).catch(() => false);
}

async function fillTarget(page: Page, target: TargetConfig, text: string): Promise<boolean> {
  const locators = target.kind === "bestInput"
    ? [
        page.locator("textarea:visible").first(),
        page.locator("input[type='text']:visible").first(),
        page.locator("input:not([type]):visible").first(),
        page.locator("[contenteditable='true']:visible").first(),
        page.locator("[role='textbox']:visible").first()
      ]
    : [locatorForTarget(page, target)];
  for (const locator of locators) {
    if (!(await locator.count().catch(() => 0))) {
      continue;
    }
    const filled = await locator.fill(text, { timeout: 2000 }).then(() => true).catch(async () => {
      await locator.click({ timeout: 1000 }).catch(() => undefined);
      return page.keyboard.type(text).then(() => true).catch(() => false);
    });
    if (filled) {
      return true;
    }
  }
  return false;
}

async function uploadTarget(page: Page, target: TargetConfig, samplePath: string): Promise<boolean> {
  const locator = target.kind === "fileInput" ? page.locator("input[type='file']").first() : locatorForTarget(page, target);
  if (!(await locator.count().catch(() => 0))) {
    return false;
  }
  return locator.setInputFiles(samplePath).then(() => true).catch(() => false);
}

function locatorForTarget(page: Page, target: TargetConfig): Locator {
  if (target.kind === "text") {
    return page.getByText(target.value).first();
  }
  if (target.kind === "role") {
    return page.getByRole(target.role as Parameters<Page["getByRole"]>[0], { name: target.name }).first();
  }
  if (target.kind === "placeholder") {
    return page.getByPlaceholder(target.value).first();
  }
  if (target.kind === "css") {
    return page.locator(target.selector).first();
  }
  if (target.kind === "fileInput") {
    return page.locator("input[type='file']").first();
  }
  return page.locator("textarea:visible, input[type='text']:visible, input:not([type]):visible, [contenteditable='true']:visible, [role='textbox']:visible").first();
}

async function collectDomSignals(page: Page, profile: AuditProfile): Promise<Record<string, boolean | number | string | string[]>> {
  return page.evaluate((profilePayload) => {
    const text = document.body.innerText.toLowerCase();
    const hasAny = (needles: string[]) => needles.some((needle) => text.includes(needle.toLowerCase()));
    const buttons = Array.from(document.querySelectorAll("button, a, [role='button']"))
      .map((element) => (element.textContent ?? element.getAttribute("aria-label") ?? "").trim())
      .filter(Boolean)
      .slice(0, 50);
    const inputs = document.querySelectorAll("textarea, input[type='text'], input:not([type]), [contenteditable='true'], [role='textbox']").length;
    const fileInputs = document.querySelectorAll("input[type='file']").length;
    const disabledControls = document.querySelectorAll("button:disabled, input:disabled, textarea:disabled").length;
    const formulaNeedles = ["formula", "math", "latex", "equation", "公式", "数学", "方程"];
    const uploadNeedles = ["upload", "attach", "file", "image", "上传", "附件", "拍照", "图片"];
    const voiceNeedles = ["voice", "mic", "microphone", "record", "语音", "麦克风", "录音"];
    const emptyNeedles = ["empty", "no data", "start", "开始", "暂无", "还没有", "提问"];
    const errorNeedles = profilePayload.failureSignals;
    return {
      title: document.title,
      bodyTextLength: text.length,
      buttons,
      inputCount: inputs,
      fileInputCount: fileInputs,
      disabledControls,
      learningEntry: hasAny(["learn", "practice", "homework", "学习", "练习", "作业", "答疑"]),
      chatInput: inputs > 0,
      sendAction: hasAny(["send", "submit", "ask", "发送", "提交", "提问"]) || buttons.some((button) => /send|submit|ask|发送|提交|提问/i.test(button)),
      formulaAffordance: hasAny(formulaNeedles),
      uploadAffordance: fileInputs > 0 || hasAny(uploadNeedles),
      voiceAffordance: hasAny(voiceNeedles),
      emptyState: hasAny(emptyNeedles),
      visibleFailureSignal: hasAny(errorNeedles)
    };
  }, { failureSignals: profile.failureSignals });
}

async function collectBBoxElements(page: Page): Promise<BBoxElement[]> {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll("button, input, textarea, select, [role='status'], [aria-label]"));
    const selectorFor = (element: Element): string => {
      const tag = element.tagName.toLowerCase();
      const id = element.getAttribute("id");
      if (id) {
        return `${tag}#${id}`;
      }
      const testId = element.getAttribute("data-testid");
      if (testId) {
        return `${tag}[data-testid="${testId}"]`;
      }
      const ariaLabel = element.getAttribute("aria-label");
      if (ariaLabel) {
        return `${tag}[aria-label="${ariaLabel.slice(0, 40)}"]`;
      }
      const role = element.getAttribute("role");
      if (role) {
        return `${tag}[role="${role}"]`;
      }
      return tag;
    };

    return candidates.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      if (!visible) {
        return [];
      }
      return [{
        selector: selectorFor(element),
        role: element.getAttribute("role") ?? undefined,
        text: (element.textContent ?? (element as HTMLInputElement).value ?? "").trim().replace(/\s+/g, " ").slice(0, 80) || undefined,
        ariaLabel: element.getAttribute("aria-label") ?? undefined,
        bbox: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      }];
    });
  });
}

export function detectBBoxOverflows(elements: BBoxElement[], viewportWidth: number): BBoxOverflow[] {
  return elements.flatMap((element) => {
    const overflowLeft = Math.max(0, -element.bbox.x);
    const overflowRight = Math.max(0, element.bbox.x + element.bbox.width - viewportWidth);
    if (overflowLeft === 0 && overflowRight === 0) {
      return [];
    }
    return [{
      selector: element.selector,
      role: element.role,
      text: element.text,
      ariaLabel: element.ariaLabel,
      bbox: element.bbox,
      viewportWidth,
      overflowLeft,
      overflowRight
    }];
  });
}

function buildSignalFindings(
  profile: AuditProfile,
  journeyId: string,
  viewport: ViewportName,
  expectedSignals: string[],
  signals: Record<string, boolean | number | string | string[]>,
  screenshots: string[],
  reproBase: string[]
): Finding[] {
  const findings: Finding[] = [];
  for (const signal of expectedSignals) {
    if (signals[signal] === false || signals[signal] === 0 || signals[signal] === undefined) {
      const severity = signal === "chatInput" || signal === "learningEntry" ? "P1" : "P2";
      findings.push({
        severity,
        title: `Missing expected ${signal} signal`,
        journey: journeyId,
        viewport,
        userSymptom: `A ${profile.name} user may not discover or complete the expected ${signal} behavior.`,
        expected: `The page should expose a clear ${signal} affordance during the tested journey.`,
        actual: `The DOM audit did not detect ${signal}.`,
        evidence: [{ type: "screenshot", path: screenshots.at(-1), detail: "Latest screenshot after scripted journey" }],
        reproSteps: [...reproBase, `Look for ${signal}`],
        acceptanceCriteria: [`A visible, keyboard-accessible ${signal} control or state is present`, "The control remains available on audited viewports"]
      });
    }
  }
  if (signals.visibleFailureSignal === true) {
    findings.push({
      severity: "P1",
      title: "Visible failure language appears during the journey",
      journey: journeyId,
      viewport,
      userSymptom: "The user sees generic error or failure language while trying the core flow.",
      expected: "Errors should be absent, or specific and recoverable when an action cannot complete.",
      actual: "The page text matched one or more profile failure signals.",
      evidence: [{ type: "screenshot", path: screenshots.at(-1), detail: "Screenshot after journey execution" }],
      reproSteps: reproBase,
      acceptanceCriteria: ["No generic failure copy appears in the happy path", "Recoverable errors include a next action"]
    });
  }
  return findings;
}

function buildBBoxOverflowFindings(
  profile: AuditProfile,
  journeyId: string,
  viewport: ViewportName,
  overflows: BBoxOverflow[],
  snapshots: BBoxSnapshot[],
  timelineEvents: TimelineEvent[],
  screenshots: string[],
  reproBase: string[]
): Finding[] {
  return overflows.map((overflow) => {
    const introducedAt = findIntroducedAtStep(overflow, snapshots);
    const introducedAtEvent = findIntroducedAtEvent(overflow, timelineEvents);
    const stateChainPath = introducedAtEvent ? stateChainPathForEvent(introducedAtEvent) : undefined;
    const classification = classifyBBoxOverflow(overflow, profile.criticalControls);
    const label = overflow.ariaLabel ?? overflow.text ?? overflow.role ?? overflow.selector;
    const overflowText = overflow.overflowLeft > 0
      ? `x is ${overflow.bbox.x}, ${overflow.overflowLeft}px beyond the left viewport edge`
      : `x + width is ${overflow.bbox.x + overflow.bbox.width}, ${overflow.overflowRight}px beyond viewport width ${overflow.viewportWidth}`;
    return {
      severity: classification.severity,
      title: classification.critical
        ? `Critical ${classification.controlName} control overflows viewport: ${label}`
        : `Review non-critical element overflow: ${label}`,
      journey: journeyId,
      viewport,
      introducedAtStep: introducedAt ? { index: introducedAt.stepIndex, label: introducedAt.stepLabel, action: introducedAt.action } : undefined,
      introducedAtEvent: introducedAtEvent ? {
        viewport: introducedAtEvent.viewport,
        journey: introducedAtEvent.journey,
        stepIndex: introducedAtEvent.stepIndex,
        stepLabel: introducedAtEvent.stepLabel,
        action: introducedAtEvent.action,
        event: introducedAtEvent.event,
        timestamp: introducedAtEvent.timestamp,
        elapsedMs: introducedAtEvent.elapsedMs,
        screenshot: introducedAtEvent.screenshot,
        bboxPath: introducedAtEvent.bboxPath,
        domPath: introducedAtEvent.domPath,
        stateChainPath,
        domSummary: introducedAtEvent.domSummary,
        consoleSummary: introducedAtEvent.consoleSummary,
        networkSummary: introducedAtEvent.networkSummary
      } : undefined,
      confidence: classification.critical ? "high" : "medium",
      tags: ["bbox", "overflow", "layout", viewport, classification.critical ? "critical-control" : "review", ...(classification.controlName ? [`control:${classification.controlName}`] : [])],
      userSymptom: classification.critical
        ? "A mobile user may see composer/status controls clipped, shifted offscreen, or hard to tap."
        : "A visible element leaves the viewport and should be reviewed to distinguish intentional off-canvas UI from a layout bug.",
      expected: classification.critical
        ? "Visible critical composer/status/upload/voice/send controls should stay fully inside the viewport."
        : "Non-critical visible elements should either stay inside the viewport or be explicitly marked as intentional off-canvas UI.",
      actual: `${overflowText}. Selector: ${overflow.selector}. BBox: ${JSON.stringify(overflow.bbox)}.`,
      evidence: [
        ...(introducedAtEvent ? [
          { type: "screenshot" as const, path: introducedAtEvent.screenshot, detail: `Timeline screenshot captured at event ${introducedAtEvent.event}` },
          { type: "bbox" as const, path: introducedAtEvent.bboxPath, detail: `Timeline bbox captured at event ${introducedAtEvent.event}; selector=${overflow.selector}; role=${overflow.role ?? "n/a"}; text=${overflow.text ?? overflow.ariaLabel ?? "n/a"}; bbox=${JSON.stringify(overflow.bbox)}; viewportWidth=${overflow.viewportWidth}; overflowLeft=${overflow.overflowLeft}; overflowRight=${overflow.overflowRight}` },
          { type: "dom" as const, path: introducedAtEvent.domPath, detail: `Timeline DOM/status summary captured at event ${introducedAtEvent.event}` },
          ...(stateChainPath ? [{ type: "dom" as const, path: stateChainPath, detail: `State-chain manifest for step ${introducedAtEvent.stepIndex} with first bad frame ${introducedAtEvent.event}` }] : [])
        ] : []),
        { type: "bbox", path: introducedAt?.artifactPath, detail: `selector=${overflow.selector}; role=${overflow.role ?? "n/a"}; text=${overflow.text ?? overflow.ariaLabel ?? "n/a"}; bbox=${JSON.stringify(overflow.bbox)}; viewportWidth=${overflow.viewportWidth}; overflowLeft=${overflow.overflowLeft}; overflowRight=${overflow.overflowRight}; introducedAtStep=${introducedAt ? `${introducedAt.stepIndex} ${introducedAt.stepLabel}` : "unknown"}` },
        { type: "screenshot", path: introducedAt?.screenshot ?? screenshots.at(-1), detail: introducedAt ? "Screenshot captured at the first step where overflow was observed" : "Latest screenshot after the audited journey" }
      ],
      reproSteps: [...reproBase, ...(introducedAt ? [`Run step ${introducedAt.stepIndex}: ${introducedAt.stepLabel} (${introducedAt.action})`] : []), ...(introducedAtEvent ? [`Inspect timeline event ${introducedAtEvent.event}`] : []), `Inspect ${overflow.selector} bounding box`],
      acceptanceCriteria: [
        classification.critical
          ? "The critical control has x >= 0 and x + width <= viewport width on mobile and small-mobile."
          : "The element is either contained within the viewport or documented as intentional off-canvas UI.",
        "Status, upload, voice, and send controls do not push each other outside the viewport.",
        "Long state copy wraps, truncates, or reserves space without clipping primary controls."
      ]
    };
  });
}

export function classifyBBoxOverflow(overflow: BBoxOverflow, criticalControls: CriticalControlRule[]): BBoxOverflowClassification {
  const matched = criticalControls.find((control) => matchesCriticalControl(overflow, control));
  if (matched) {
    return { critical: true, controlName: matched.name, severity: "P1", reviewOnly: false };
  }
  return { critical: false, severity: "P2", reviewOnly: true };
}

function matchesCriticalControl(overflow: BBoxOverflow, control: CriticalControlRule): boolean {
  return matchesAny(overflow.selector, control.selectorIncludes)
    || matchesAny(overflow.role, control.role)
    || matchesAny(overflow.text, control.textIncludes)
    || matchesAny(overflow.ariaLabel, control.ariaLabelIncludes);
}

function matchesAny(value: string | undefined, needles: string[] | undefined): boolean {
  if (!value || !needles?.length) {
    return false;
  }
  const normalized = value.toLowerCase();
  return needles.some((needle) => normalized.includes(needle.toLowerCase()));
}

export function findIntroducedAtStep(overflow: BBoxOverflow, snapshots: BBoxSnapshot[]): BBoxSnapshot | undefined {
  return snapshots.find((snapshot) => snapshot.overflows.some((candidate) => sameOverflowTarget(candidate, overflow)));
}

export function findIntroducedAtEvent(overflow: BBoxOverflow, timelineEvents: TimelineEvent[]): TimelineEvent | undefined {
  return timelineEvents.find((event) => event.bboxOverflows.some((candidate) => sameOverflowTarget(candidate, overflow)));
}

function stateChainPathForEvent(event: TimelineEvent): string {
  return join(dirname(event.screenshot), "state-chain.json");
}

function sameOverflowTarget(left: BBoxOverflow, right: BBoxOverflow): boolean {
  return left.selector === right.selector
    && left.role === right.role
    && left.text === right.text
    && left.ariaLabel === right.ariaLabel;
}

function buildRuntimeFindings(
  viewport: ViewportName,
  journeyId: string,
  consoleErrors: string[],
  networkFailures: string[],
  screenshots: string[],
  reproBase: string[]
): Finding[] {
  const findings: Finding[] = [];
  if (consoleErrors.length > 0) {
    findings.push({
      severity: "P2",
      title: "Console errors or warnings occurred",
      journey: journeyId,
      viewport,
      userSymptom: "The page may behave inconsistently even if the visible UI seems usable.",
      expected: "The tested journey should not emit console errors.",
      actual: consoleErrors.slice(0, 5).join(" | "),
      evidence: [
        { type: "console", detail: `${consoleErrors.length} console error/warning entries captured` },
        { type: "screenshot", path: screenshots.at(-1), detail: "Final journey screenshot" }
      ],
      reproSteps: reproBase,
      acceptanceCriteria: ["Console is clean for the audited happy path", "Known benign warnings are documented or suppressed"]
    });
  }
  if (networkFailures.length > 0) {
    findings.push({
      severity: "P1",
      title: "Network requests failed during the journey",
      journey: journeyId,
      viewport,
      userSymptom: "The user may see missing data, stuck loading, or broken submission.",
      expected: "Critical network calls complete or fail with a recoverable user-facing state.",
      actual: networkFailures.slice(0, 5).join(" | "),
      evidence: [
        { type: "network", detail: `${networkFailures.length} failed requests captured` },
        { type: "screenshot", path: screenshots.at(-1), detail: "Final journey screenshot" }
      ],
      reproSteps: reproBase,
      acceptanceCriteria: ["No critical request fails in the audited flow", "Any intentional failure has a visible recovery path"]
    });
  }
  return findings;
}

function navigationFinding(url: string, viewport: ViewportName, journeyId: string, detail: string | undefined, screenshot: string, reproBase: string[]): Finding {
  return {
    severity: "P0",
    title: "Page cannot be opened reliably",
    journey: journeyId,
    viewport,
    userSymptom: "The user cannot reach the product entry point.",
    expected: "The page loads enough UI to begin the product journey.",
    actual: detail ?? `Navigation to ${url} failed.`,
    evidence: [{ type: "screenshot", path: screenshot, detail: "Navigation failure screenshot" }],
    reproSteps: reproBase,
    acceptanceCriteria: ["Target URL loads within 15 seconds", "The first interactive product surface is visible"]
  };
}

function stepFailureFinding(profile: AuditProfile, journey: AuditJourney, step: JourneyStep, viewport: ViewportName, detail: string | undefined, screenshot: string, reproBase: string[]): Finding {
  return {
    severity: step.severity ?? defaultStepSeverity(step),
    title: `Step failed: ${step.label}`,
    journey: journey.id,
    viewport,
    userSymptom: `A ${profile.name} user cannot complete "${journey.title}" at the "${step.label}" step.`,
    expected: `The "${step.label}" step should complete or be marked optional.`,
    actual: detail ?? "The step failed during execution.",
    evidence: [{ type: "screenshot", path: screenshot, detail: "Screenshot captured immediately after step failure" }],
    reproSteps: [...reproBase, step.label],
    acceptanceCriteria: [`The "${step.label}" step succeeds for ${journey.title}`, "The failure case has a visible recovery path if the action is unavailable"]
  };
}

function enrichFindings(findings: Finding[]): void {
  findings.forEach((finding, index) => {
    finding.id ??= `F-${String(index + 1).padStart(3, "0")}`;
    finding.confidence ??= finding.title.startsWith("Step failed") || finding.severity === "P0" ? "high" : "medium";
    finding.affectedViewports ??= [finding.viewport];
    finding.tags ??= tagsForFinding(finding);
  });
}

function tagsForFinding(finding: Finding): string[] {
  const tags = new Set<string>([finding.journey, finding.viewport]);
  if (finding.title.includes("Console")) {
    tags.add("runtime");
  }
  if (finding.title.includes("Network")) {
    tags.add("network");
  }
  if (finding.title.includes("Missing expected")) {
    tags.add("missing-signal");
  }
  if (finding.title.includes("overflows viewport") || finding.title.includes("element overflow")) {
    tags.add("bbox");
    tags.add("overflow");
    tags.add("layout");
  }
  if (finding.title.startsWith("Step failed")) {
    tags.add("journey-step");
  }
  return Array.from(tags);
}

function defaultStepSeverity(step: JourneyStep): Severity {
  if (step.action === "open") {
    return "P0";
  }
  if (step.action === "fill" || step.action === "press") {
    return "P1";
  }
  return "P2";
}

function renderTemplate(value: string, profile: AuditProfile): string {
  return value.replaceAll("{{testQuestion}}", profile.testQuestion);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "step";
}

async function currentGitCommit(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"]);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export function relativeArtifactPath(outDir: string, path: string): string {
  return relative(outDir, path);
}
