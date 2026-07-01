#!/usr/bin/env node
import { runAudit } from "@codex-product-dogfood/runner";

interface ParsedArgs {
  command?: string;
  url?: string;
  profile: "ai-chat" | "student-learning";
  outDir: string;
  headed: boolean;
  help: boolean;
}

const helpText = `codex-product-dogfood

Usage:
  codex-product-dogfood audit <url> --profile <ai-chat|student-learning> [--out <dir>] [--headed]

Examples:
  codex-product-dogfood audit https://staging.study.zhanzhanai.com --profile student-learning
  codex-product-dogfood audit https://example.com --profile ai-chat --out runtime/audits/example

Options:
  --profile   Audit profile. Required for audit.
  --out       Output directory. Default: runtime/audits/latest
  --headed    Show the browser while auditing.
  --help      Show this help.
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    console.log(helpText);
    return;
  }
  if (args.command !== "audit") {
    throw new Error(`Unknown command "${args.command}".\n\n${helpText}`);
  }
  if (!args.url) {
    throw new Error(`Missing URL.\n\n${helpText}`);
  }
  const report = await runAudit({
    url: args.url,
    profile: args.profile,
    outDir: args.outDir,
    headed: args.headed
  });
  console.log(`Report: ${args.outDir}/report.md`);
  console.log(`Findings: ${args.outDir}/findings.json`);
  console.log(`Screenshots: ${args.outDir}/screenshots/`);
  console.log(`Maturity: ${report.summary.maturity.score}/100 (${report.summary.maturity.releaseReadiness})`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    profile: "ai-chat",
    outDir: "runtime/audits/latest",
    headed: false,
    help: false
  };
  parsed.command = argv[0];
  parsed.url = argv[1]?.startsWith("-") ? undefined : argv[1];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      parsed.help = true;
    }
    if (token === "--profile") {
      const value = argv[index + 1];
      if (value !== "ai-chat" && value !== "student-learning") {
        throw new Error(`Invalid --profile "${value}". Expected ai-chat or student-learning.`);
      }
      parsed.profile = value;
      index += 1;
    }
    if (token === "--out") {
      parsed.outDir = argv[index + 1] ?? parsed.outDir;
      index += 1;
    }
    if (token === "--headed") {
      parsed.headed = true;
    }
  }
  return parsed;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
