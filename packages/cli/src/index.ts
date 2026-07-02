#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Command, Option } from "commander";
import { runAudit } from "@codex-product-dogfood/runner";

const program = new Command();

program
  .name("codex-product-dogfood")
  .description("Audit web products like a real user and turn findings into a development plan.")
  .version("0.1.0");

program
  .command("audit")
  .description("Run a real-user audit against a web URL.")
  .argument("<url>", "Target URL to audit")
  .option("--profile <name>", "Built-in profile: ai-chat or student-learning", "ai-chat")
  .option("--profile-file <path>", "Path to a YAML profile file")
  .option("--out <dir>", "Output directory", "runtime/audits/latest")
  .option("--journey <id>", "Run only one journey from the selected profile")
  .addOption(new Option("--viewport <name>", "Run only one viewport").choices(["desktop", "mobile", "small-mobile"]))
  .option("--headed", "Show the browser while auditing", false)
  .option("--timeout-ms <number>", "Navigation timeout in milliseconds", parseInteger)
  .option("--json", "Print the summary as JSON", false)
  .action(async (url, options) => {
    const report = await runAudit({
      url,
      profile: options.profile,
      profileFile: options.profileFile,
      outDir: options.out,
      journey: options.journey,
      viewport: options.viewport,
      headed: options.headed,
      timeoutMs: options.timeoutMs
    });
    if (options.json) {
      console.log(JSON.stringify(report.summary, null, 2));
      return;
    }
    console.log(`Report: ${options.out}/report.md`);
    console.log(`Findings: ${options.out}/findings.json`);
    console.log(`Screenshots: ${options.out}/screenshots/`);
    console.log(`Maturity: ${report.summary.maturity.score}/100 (${report.summary.maturity.releaseReadiness})`);
  });

program
  .command("profiles")
  .description("List built-in audit profiles.")
  .action(() => {
    console.log("ai-chat");
    console.log("student-learning");
  });

program
  .command("init-profile")
  .description("Write a starter YAML profile.")
  .option("--out <path>", "Output YAML path", "profile.yaml")
  .action(async (options) => {
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, starterProfileYaml);
    console.log(`Wrote ${options.out}`);
  });

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received "${value}".`);
  }
  return parsed;
}

const starterProfileYaml = `name: custom-profile
description: Describe the target user and product category.
testQuestion: Enter a realistic user prompt.
viewports:
  - desktop
primaryEntryKeywords:
  - start
  - ask
expectedSignals:
  - chatInput
failureSignals:
  - error
  - failed
journeys:
  - id: first-run
    title: First run
    userGoal: User can start the core journey.
    steps:
      - action: open
      - action: click
        label: Click a likely primary entry
        target:
          kind: keyword
          values:
            - start
            - ask
        optional: true
      - action: fill
        label: Fill the primary input
        target:
          kind: bestInput
        value: "{{testQuestion}}"
      - action: press
        label: Submit with Enter
        key: Enter
      - action: observe
        label: Observe the result
`;
