import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_REPORT_FILE = path.join(ROOT_DIR, "artifacts", "relevance-report.json");
const DEFAULT_BASELINE_FILE = path.join(ROOT_DIR, "tests", "relevance", "baseline-summary.json");

Promise.resolve(main()).catch((error) => {
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
  const write = getArg(args, ["write"]) === "true";
  const overwriteCriticalCases = getArg(args, ["overwrite-critical-cases"]) === "true";

  const report = loadJson(reportFile, "report");
  const existingBaseline = loadJson(baselineFile, "baseline");

  const maxFailIncrease = toNumber(
    getArg(args, ["max-fail-increase", "maxFailIncrease"]),
    toNumber(existingBaseline.maxFailIncrease, 3)
  );

  const maxPassRateDrop = toNumber(
    getArg(args, ["max-pass-rate-drop", "maxPassRateDrop"]),
    toNumber(existingBaseline.maxPassRateDrop, 0.15)
  );

  const manualCriticalCases = parseCsv(getArg(args, ["critical-cases", "criticalCases"]));
  const existingCriticalCases = Array.isArray(existingBaseline.criticalCases)
    ? existingBaseline.criticalCases
    : [];

  const criticalCases = manualCriticalCases.length > 0
    ? manualCriticalCases
    : overwriteCriticalCases
      ? []
      : existingCriticalCases;

  const summary = buildSummary({
    report,
    maxFailIncrease,
    maxPassRateDrop,
    criticalCases
  });

  if (!write) {
    console.log("Quarterly baseline candidate (dry-run, file not written):");
    console.log(JSON.stringify(summary, null, 2));
    console.log("");
    console.log("To write this baseline file, rerun with --write.");
    return;
  }

  writeJsonFile(baselineFile, summary);
  console.log(`Baseline updated: ${baselineFile}`);
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
  console.log("Usage: node scripts/relevance-baseline-update.js [options]");
  console.log("");
  console.log("Options:");
  console.log("  --report-file <path>             Relevance report JSON file");
  console.log("  --baseline-file <path>           Baseline summary JSON output file");
  console.log("  --max-fail-increase <n>          Override drift tolerance for failed-case increase");
  console.log("  --max-pass-rate-drop <n>         Override drift tolerance for pass-rate drop");
  console.log("  --critical-cases <csv>           Comma-separated critical case names to pin");
  console.log("  --overwrite-critical-cases       Drop current critical cases if no --critical-cases provided");
  console.log("  --write                          Persist baseline file");
  console.log("  --help                           Show this help");
}

function getArg(args, keys) {
  for (const key of keys) {
    if (key in args) {
      return args[key];
    }
  }
  return undefined;
}

function parseCsv(value) {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
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

function buildSummary({ report, maxFailIncrease, maxPassRateDrop, criticalCases }) {
  validateReport(report);

  return {
    generatedAt: new Date().toISOString(),
    provider: String(report.provider || "unknown"),
    caseCount: Number(report.caseCount),
    passedCount: Number(report.passedCount),
    failedCount: Number(report.failedCount),
    passRate: Number(report.passRate),
    maxFailIncrease,
    maxPassRateDrop,
    criticalCases: dedupeStrings(criticalCases)
  };
}

function validateReport(report) {
  const requiredFields = [
    "provider",
    "caseCount",
    "passedCount",
    "failedCount",
    "passRate"
  ];

  for (const field of requiredFields) {
    if (!(field in report)) {
      throw new Error(`Report is missing required field '${field}'.`);
    }
  }
}

function dedupeStrings(values) {
  const seen = new Set();
  const output = [];

  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }

  return output;
}

function writeJsonFile(filePath, body) {
  const outputDir = path.dirname(filePath);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}
