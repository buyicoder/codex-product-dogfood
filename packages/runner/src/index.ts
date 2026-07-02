import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
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
    const timelineManifest = await writeTimelineStepManifest(timelineDir, viewportName, journey.id, index, step, stepTimelineEvents);
    if (step.action === "open" && result.status === "passed") {
      opened = true;
    }
    const screenshot = await screenshotPage(page, screenshotsDir, viewportName, journey.id, index, step.action);
    screenshots.push(screenshot);
    const bboxSnapshot = await captureBBoxSnapshot(page, domDir, viewportName, journey.id, index, step, screenshot);
    bboxSnapshots.push(bboxSnapshot);
    steps.push({ journey: journey.id, step: step.label, action: step.action, status: result.status, screenshot, bboxSnapshot: bboxSnapshot.artifactPath, timelineManifest, detail: result.detail });
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
  findings.push(...buildBBoxOverflowFindings(profile, journey.id, viewportName, bboxOverflows, bboxSnapshots, screenshots, reproBase));
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
  events: TimelineEvent[]
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
    events
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
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
    const visibleImages = Array.from(document.querySelectorAll("img"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      }).length;
    const rawLatexMatches = (document.body.innerText.match(/\\(?:frac|sqrt|begin|end)|\$\$/g) ?? []).length;
    return {
      url: window.location.href,
      statusTexts,
      visibleImages,
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
  screenshots: string[],
  reproBase: string[]
): Finding[] {
  return overflows.map((overflow) => {
    const introducedAt = findIntroducedAtStep(overflow, snapshots);
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
        { type: "bbox", path: introducedAt?.artifactPath, detail: `selector=${overflow.selector}; role=${overflow.role ?? "n/a"}; text=${overflow.text ?? overflow.ariaLabel ?? "n/a"}; bbox=${JSON.stringify(overflow.bbox)}; viewportWidth=${overflow.viewportWidth}; introducedAtStep=${introducedAt ? `${introducedAt.stepIndex} ${introducedAt.stepLabel}` : "unknown"}` },
        { type: "screenshot", path: introducedAt?.screenshot ?? screenshots.at(-1), detail: introducedAt ? "Screenshot captured at the first step where overflow was observed" : "Latest screenshot after the audited journey" }
      ],
      reproSteps: [...reproBase, ...(introducedAt ? [`Run step ${introducedAt.stepIndex}: ${introducedAt.stepLabel} (${introducedAt.action})`] : []), `Inspect ${overflow.selector} bounding box`],
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
