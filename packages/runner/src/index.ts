import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { getProfile, type AuditProfile } from "@codex-product-dogfood/profiles";
import type { AuditReport, Finding, RuntimeSignal, ViewportName } from "@codex-product-dogfood/schemas";
import { assertFindingShape, countFindings } from "@codex-product-dogfood/schemas";
import { buildDevelopmentPlan, scoreMaturity, writeReport } from "@codex-product-dogfood/reporter";

export interface AuditOptions {
  url: string;
  profile: "ai-chat" | "student-learning";
  outDir?: string;
  headed?: boolean;
  timeoutMs?: number;
  keepExisting?: boolean;
}

const viewports: Record<ViewportName, { width: number; height: number; isMobile?: boolean }> = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844, isMobile: true },
  "small-mobile": { width: 375, height: 667, isMobile: true }
};

export async function runAudit(options: AuditOptions): Promise<AuditReport> {
  const profile = getProfile(options.profile);
  const outDir = resolve(options.outDir ?? "runtime/audits/latest");
  const screenshotsDir = join(outDir, "screenshots");
  if (!options.keepExisting) {
    await rm(outDir, { recursive: true, force: true });
  }
  await mkdir(screenshotsDir, { recursive: true });
  await writeFile(join(outDir, "sample-upload.txt"), "Codex Product Dogfood sample upload.\n");

  const browser = await chromium.launch({ headless: !options.headed });
  const findings: Finding[] = [];
  const signals: RuntimeSignal[] = [];
  try {
    for (const viewportName of Object.keys(viewports) as ViewportName[]) {
      const viewportResult = await auditViewport(browser, profile, options.url, viewportName, screenshotsDir, outDir, options.timeoutMs ?? 15000);
      findings.push(...viewportResult.findings);
      signals.push(viewportResult.signal);
    }
  } finally {
    await browser.close();
  }

  const maturity = scoreMaturity(findings);
  const report: AuditReport = {
    summary: {
      url: options.url,
      profile: profile.name,
      generatedAt: new Date().toISOString(),
      viewports: Object.keys(viewports) as ViewportName[],
      maturity,
      findingCounts: countFindings(findings)
    },
    findings,
    developmentPlan: buildDevelopmentPlan(findings)
  };
  for (const finding of findings) {
    assertFindingShape(finding);
  }
  await writeFile(join(outDir, "signals.json"), `${JSON.stringify(signals, null, 2)}\n`);
  await writeReport(outDir, report);
  return report;
}

async function auditViewport(
  browser: Browser,
  profile: AuditProfile,
  url: string,
  viewportName: ViewportName,
  screenshotsDir: string,
  outDir: string,
  timeoutMs: number
): Promise<{ findings: Finding[]; signal: RuntimeSignal }> {
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

  const screenshots: string[] = [];
  const findings: Finding[] = [];
  const reproBase = [
    `Open ${url}`,
    `Use ${viewportName} viewport (${viewports[viewportName].width}x${viewports[viewportName].height})`,
    `Run the ${profile.name} profile journeys`
  ];

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 8000) }).catch(() => undefined);
  } catch (error) {
    const screenshot = await screenshotPage(page, screenshotsDir, `${viewportName}-navigation-failure`);
    screenshots.push(screenshot);
    findings.push({
      severity: "P0",
      title: "Page cannot be opened reliably",
      journey: "open",
      viewport: viewportName,
      userSymptom: "The user cannot reach the product entry point.",
      expected: "The page loads enough UI to begin the product journey.",
      actual: error instanceof Error ? error.message : String(error),
      evidence: [{ type: "screenshot", path: screenshot, detail: "Navigation failure screenshot" }],
      reproSteps: reproBase,
      acceptanceCriteria: ["Target URL loads within 15 seconds", "The first interactive product surface is visible"]
    });
    await context.close();
    return { findings, signal: { viewport: viewportName, consoleErrors, networkFailures, domSignals: {}, screenshots } };
  }

  screenshots.push(await screenshotPage(page, screenshotsDir, `${viewportName}-initial`));
  await clickPrimaryEntry(page, profile);
  screenshots.push(await screenshotPage(page, screenshotsDir, `${viewportName}-after-primary-click`));
  await fillBestInput(page, profile.testQuestion);
  screenshots.push(await screenshotPage(page, screenshotsDir, `${viewportName}-after-fill`));
  await page.keyboard.press("Enter").catch(() => undefined);
  await page.waitForTimeout(1500);
  screenshots.push(await screenshotPage(page, screenshotsDir, `${viewportName}-after-submit`));
  await tryUpload(page, join(outDir, "sample-upload.txt"));
  screenshots.push(await screenshotPage(page, screenshotsDir, `${viewportName}-after-upload-attempt`));

  const domSignals = await collectDomSignals(page, profile);
  await writeFile(join(outDir, `${viewportName}-dom.json`), `${JSON.stringify(domSignals, null, 2)}\n`);
  findings.push(...buildSignalFindings(profile, viewportName, domSignals, screenshots, reproBase));
  findings.push(...buildRuntimeFindings(viewportName, consoleErrors, networkFailures, screenshots, reproBase));

  await context.close();
  return { findings, signal: { viewport: viewportName, consoleErrors, networkFailures, domSignals, screenshots } };
}

async function screenshotPage(page: Page, screenshotsDir: string, name: string): Promise<string> {
  const path = join(screenshotsDir, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

async function clickPrimaryEntry(page: Page, profile: AuditProfile): Promise<void> {
  const keywords = profile.primaryEntryKeywords;
  for (const keyword of keywords) {
    const candidate = page.getByRole("button", { name: new RegExp(keyword, "i") }).first();
    if (await candidate.count().catch(() => 0)) {
      await candidate.click({ timeout: 1500 }).catch(() => undefined);
      return;
    }
    const link = page.getByRole("link", { name: new RegExp(keyword, "i") }).first();
    if (await link.count().catch(() => 0)) {
      await link.click({ timeout: 1500 }).catch(() => undefined);
      return;
    }
  }
  const firstVisible = page.locator("button:visible, a:visible").first();
  if (await firstVisible.count().catch(() => 0)) {
    await firstVisible.click({ timeout: 1500 }).catch(() => undefined);
  }
}

async function fillBestInput(page: Page, text: string): Promise<void> {
  const selectors = [
    "textarea:visible",
    "input[type='text']:visible",
    "input:not([type]):visible",
    "[contenteditable='true']:visible",
    "[role='textbox']:visible"
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count().catch(() => 0)) {
      await locator.fill(text, { timeout: 2000 }).catch(async () => {
        await locator.click({ timeout: 1000 }).catch(() => undefined);
        await page.keyboard.type(text).catch(() => undefined);
      });
      return;
    }
  }
}

async function tryUpload(page: Page, samplePath: string): Promise<void> {
  const input = page.locator("input[type='file']").first();
  if (await input.count().catch(() => 0)) {
    await input.setInputFiles(samplePath).catch(() => undefined);
  }
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

function buildSignalFindings(
  profile: AuditProfile,
  viewport: ViewportName,
  signals: Record<string, boolean | number | string | string[]>,
  screenshots: string[],
  reproBase: string[]
): Finding[] {
  const findings: Finding[] = [];
  for (const signal of profile.expectedSignals) {
    if (signals[signal] === false || signals[signal] === 0 || signals[signal] === undefined) {
      const severity = signal === "chatInput" || signal === "learningEntry" ? "P1" : "P2";
      findings.push({
        severity,
        title: `Missing expected ${signal} signal`,
        journey: profile.journeys.map((journey) => journey.id).join(", "),
        viewport,
        userSymptom: `A ${profile.name} user may not discover or complete the expected ${signal} behavior.`,
        expected: `The page should expose a clear ${signal} affordance during the tested journey.`,
        actual: `The MVP DOM audit did not detect ${signal}.`,
        evidence: [{ type: "screenshot", path: screenshots.at(-1), detail: "Latest screenshot after scripted journey" }],
        reproSteps: [...reproBase, `Look for ${signal}`],
        acceptanceCriteria: [`A visible, keyboard-accessible ${signal} control or state is present`, "The control remains available on desktop and mobile viewports"]
      });
    }
  }
  if (signals.visibleFailureSignal === true) {
    findings.push({
      severity: "P1",
      title: "Visible failure language appears during the journey",
      journey: "runtime-observation",
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

function buildRuntimeFindings(
  viewport: ViewportName,
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
      journey: "runtime-observation",
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
      journey: "runtime-observation",
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
