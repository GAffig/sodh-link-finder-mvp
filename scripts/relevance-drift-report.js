import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_REPORT_FILE = path.join(ROOT_DIR, "artifacts", "relevance-report.json");
const DEFAULT_BASELINE_FILE = path.join(ROOT_DIR, "tests", "relevance", "baseline-summary.json");

main().catch((error) => {
  console.error(`ERROR: ${String(error?.stack || error)}`);
  process.exit(1);
});

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const reportFile = resolvePath(getArg(args, ["report-file", "reportFile"]) || DEFAULT_REPORT_FILE);
  const baselineFile = resolvePath(getArg(args, ["baseline-file", "baselineFile"]) || DEFAULT_BASELINE_FILE);

  const report = loadJson(reportFile, "report");
  const baseline = loadJson(baselineFile, "baseline");

  const maxFailIncrease = toNumber(
    getArg(args, ["max-fail-increase", "maxFailIncrease"]),
    toNumber(baseline.maxFailIncrease, 3)
  );

  const maxPassRateDrop = toNumber(
    getArg(args, ["max-pass-rate-drop", "maxPassRateDrop"]),
    toNumber(baseline.maxPassRateDrop, 0.15)
  );

  const criticalCases = Array.isArray(baseline.criticalCases) ? baseline.criticalCases : [];

  const failIncrease = report.failedCount - baseline.failedCount;
  const passRateDrop = baseline.passRate - report.passRate;
  const failingCritical = criticalCases.filter((name) => {
    const match = report.cases.find((item) => item.name === name);
    return !match || !match.pass;
  });

  const checks = [
    {
      name: "fail-increase",
      pass: failIncrease <= maxFailIncrease,
      details: `current failed=${report.failedCount}, baseline failed=${baseline.failedCount}, increase=${failIncrease}, allowed<=${maxFailIncrease}`
    },
    {
      name: "pass-rate-drop",
      pass: passRateDrop <= maxPassRateDrop,
      details: `current passRate=${formatPct(report.passRate)}, baseline passRate=${formatPct(baseline.passRate)}, drop=${formatPct(passRateDrop)}, allowed<=${formatPct(maxPassRateDrop)}`
    },
    {
      name: "critical-cases",
      pass: failingCritical.length === 0,
      details: failingCritical.length === 0
        ? "all critical cases passed"
        : `failing critical cases: ${failingCritical.join(", ")}`
    }
  ];

  const hasRegression = checks.some((check) => !check.pass);

  console.log("Relevance Drift Report");
  console.log(`  report: ${reportFile}`);
  console.log(`  baseline: ${baselineFile}`);
  console.log(`  case count: ${report.caseCount}`);
  console.log(`  passed: ${report.passedCount}`);
  console.log(`  failed: ${report.failedCount}`);
  console.log(`  pass rate: ${formatPct(report.passRate)}`);

  for (const check of checks) {
    console.log(`  [${check.pass ? "ok" : "x"}] ${check.name}: ${check.details}`);
  }

  if (hasRegression) {
    console.log("Result: REGRESSION DETECTED");
    process.exit(1);
  }

  console.log("Result: NO REGRESSION");
  process.exit(0);
}

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }

    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }

    args[key] = next;
    i += 1;
  }

  return args;
}

function printHelp() {
  console.log("Usage: node scripts/relevance-drift-report.js [options]");
  console.log("");
  console.log("Options:");
  console.log("  --report-file <path>       Relevance report JSON file");
  console.log("  --baseline-file <path>     Baseline summary JSON file");
  console.log("  --max-fail-increase <n>    Allowed failed-case increase vs baseline");
  console.log("  --max-pass-rate-drop <n>   Allowed pass-rate drop vs baseline (0.15 = 15%)");
  console.log("  --help                     Show this help");
}

function getArg(args, keys) {
  for (const key of keys) {
    if (key in args) {
      return args[key];
    }
  }
  return undefined;
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolvePath(candidatePath) {
  if (path.isAbsolute(candidatePath)) {
    return candidatePath;
  }
  return path.join(ROOT_DIR, candidatePath);
}

function loadJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${label} file '${filePath}': ${String(error?.message || error)}`);
  }
}

function formatPct(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}
