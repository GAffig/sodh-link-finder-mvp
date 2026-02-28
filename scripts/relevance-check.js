import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { resolveConfiguredProvider } from "../src/search/providers.js";
import { runSearchPipeline } from "../src/search/ranker.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_GOLDEN_FILE = path.join(ROOT_DIR, "tests", "relevance", "golden-queries.json");

main().catch((error) => {
  console.error(`ERROR: ${String(error?.stack || error)}`);
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  loadDotEnv(path.join(ROOT_DIR, ".env"));

  const provider = resolveConfiguredProvider(process.env);
  if (!provider) {
    console.error("ERROR: Search provider not configured.");
    console.error("Set BRAVE_API_KEY, SERPAPI_KEY, or BING_API_KEY in .env, then rerun.");
    process.exit(2);
  }

  const goldenFile = args.file || DEFAULT_GOLDEN_FILE;
  const cases = loadCases(goldenFile);
  const maxQueries = toPositiveInt(getArg(args, ["max-queries", "maxQueries"]), cases.length);
  const topNDefault = toPositiveInt(getArg(args, ["top-n", "topN"]), 8);
  const delayMs = toPositiveInt(getArg(args, ["delay-ms", "delayMs"]), 250);
  const reportFile = getArg(args, ["report-file", "reportFile"]);
  const runStartedAt = Date.now();

  const selectedCases = cases.slice(0, maxQueries);

  console.log(`Provider: ${provider.name}`);
  console.log(`Golden file: ${goldenFile}`);
  console.log(`Cases: ${selectedCases.length}`);
  console.log("");

  const results = [];

  for (let index = 0; index < selectedCases.length; index += 1) {
    const testCase = selectedCases[index];
    const topN = toPositiveInt(testCase.topN, topNDefault);

    process.stdout.write(`[${index + 1}/${selectedCases.length}] ${testCase.name} ... `);

    const startedAt = Date.now();

    try {
      const pipelineOutput = await runSearchPipeline({
        query: testCase.query,
        provider
      });

      const elapsedMs = Date.now() - startedAt;
      const evaluation = evaluateCase(testCase, pipelineOutput.results, topN);
      results.push({
        name: testCase.name,
        query: testCase.query,
        elapsedMs,
        topN,
        evaluation,
        results: pipelineOutput.results
      });

      if (evaluation.pass) {
        console.log(`PASS (${elapsedMs}ms)`);
      } else {
        console.log(`FAIL (${elapsedMs}ms)`);
      }
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      results.push({
        name: testCase.name,
        query: testCase.query,
        elapsedMs,
        topN,
        evaluation: {
          pass: false,
          checks: [{
            name: "execution",
            pass: false,
            details: `Query execution failed: ${String(error?.message || error)}`
          }]
        },
        results: []
      });

      console.log(`FAIL (${elapsedMs}ms)`);
    }

    if (delayMs > 0 && index < selectedCases.length - 1) {
      await sleep(delayMs);
    }
  }

  console.log("\nDetailed Report\n");

  for (const item of results) {
    const status = item.evaluation.pass ? "PASS" : "FAIL";
    console.log(`${status} - ${item.name}`);
    console.log(`Query: ${item.query}`);

    for (const check of item.evaluation.checks) {
      const checkStatus = check.pass ? "ok" : "x";
      console.log(`  [${checkStatus}] ${check.name}: ${check.details}`);
    }

    const topRows = item.results.slice(0, Math.min(5, item.results.length));
    if (topRows.length > 0) {
      console.log("  Top results:");
      for (const row of topRows) {
        const priority = row.isPriority ? "priority" : "general";
        console.log(`    - (${priority}) ${row.domain} :: ${row.title}`);
      }
    }

    console.log("");
  }

  const failed = results.filter((item) => !item.evaluation.pass);
  const passedCount = results.length - failed.length;
  const report = buildRunReport({
    provider: provider.name,
    goldenFile,
    startedAtMs: runStartedAt,
    results,
    passedCount,
    failedCount: failed.length
  });

  console.log("Summary");
  console.log(`  Passed: ${passedCount}`);
  console.log(`  Failed: ${failed.length}`);

  if (reportFile) {
    writeReportFile(reportFile, report);
    console.log(`  Report file: ${reportFile}`);
  }

  if (failed.length > 0) {
    console.log("  Failed cases:");
    for (const item of failed) {
      console.log(`    - ${item.name}`);
    }
    process.exit(1);
  }

  process.exit(0);
}

function evaluateCase(testCase, results, topN) {
  const checks = [];
  const topSlice = results.slice(0, topN);
  const topDomains = topSlice.map((row) => row.domain.toLowerCase());

  const minResults = toPositiveInt(testCase.minResults, 8);
  checks.push({
    name: "min-results",
    pass: results.length >= minResults,
    details: `expected >= ${minResults}, got ${results.length}`
  });

  if (Array.isArray(testCase.requiredAnyDomains) && testCase.requiredAnyDomains.length > 0) {
    const found = testCase.requiredAnyDomains.find((domain) => domainSeen(topDomains, domain));
    checks.push({
      name: "required-any-domain",
      pass: Boolean(found),
      details: found
        ? `found ${found} in top ${topN}`
        : `expected one of [${testCase.requiredAnyDomains.join(", ")}] in top ${topN}`
    });
  }

  if (Array.isArray(testCase.requiredDomains) && testCase.requiredDomains.length > 0) {
    const missing = testCase.requiredDomains.filter((domain) => !domainSeen(topDomains, domain));
    checks.push({
      name: "required-domains",
      pass: missing.length === 0,
      details: missing.length === 0
        ? `all required domains present in top ${topN}`
        : `missing from top ${topN}: ${missing.join(", ")}`
    });
  }

  if (Array.isArray(testCase.preferredTop1Domains) && testCase.preferredTop1Domains.length > 0) {
    const top1 = results[0]?.domain?.toLowerCase() || "none";
    const matches = testCase.preferredTop1Domains.some((domain) => hostMatches(top1, domain));
    checks.push({
      name: "preferred-top1-domain",
      pass: matches,
      details: `top1=${top1}; expected one of [${testCase.preferredTop1Domains.join(", ")}]`
    });
  }

  if (Array.isArray(testCase.forbiddenTop1Domains) && testCase.forbiddenTop1Domains.length > 0) {
    const top1 = results[0]?.domain?.toLowerCase() || "none";
    const forbidden = testCase.forbiddenTop1Domains.find((domain) => hostMatches(top1, domain));
    checks.push({
      name: "forbidden-top1-domain",
      pass: !forbidden,
      details: forbidden
        ? `top1=${top1} matched forbidden domain ${forbidden}`
        : `top1=${top1} not in forbidden list`
    });
  }

  if (typeof testCase.minPriorityInTopN === "number") {
    const minimum = toPositiveInt(testCase.minPriorityInTopN, 0);
    const count = topSlice.filter((row) => row.isPriority).length;
    checks.push({
      name: "priority-count-topN",
      pass: count >= minimum,
      details: `expected >= ${minimum}, got ${count} (top ${topN})`
    });
  }

  if (typeof testCase.minDistinctDomainsTopN === "number") {
    const minimum = toPositiveInt(testCase.minDistinctDomainsTopN, 1);
    const count = new Set(topDomains).size;
    checks.push({
      name: "distinct-domains-topN",
      pass: count >= minimum,
      details: `expected >= ${minimum}, got ${count} (top ${topN})`
    });
  }

  return {
    pass: checks.every((check) => check.pass),
    checks
  };
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
  console.log("Usage: node scripts/relevance-check.js [options]");
  console.log("");
  console.log("Options:");
  console.log("  --file <path>         Path to golden query JSON file");
  console.log("  --top-n <number>      Default top-N window (default: 8)");
  console.log("  --max-queries <n>     Run only first n cases");
  console.log("  --delay-ms <number>   Pause between queries in milliseconds (default: 250)");
  console.log("  --report-file <path>  Write JSON report file for benchmark/drift tracking");
  console.log("  --help                Show this help");
}

function loadCases(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Golden file must be a non-empty JSON array.");
  }

  for (const [index, item] of parsed.entries()) {
    if (typeof item?.name !== "string" || !item.name.trim()) {
      throw new Error(`Case ${index + 1} missing valid 'name'.`);
    }
    if (typeof item?.query !== "string" || !item.query.trim()) {
      throw new Error(`Case ${index + 1} missing valid 'query'.`);
    }
  }

  return parsed;
}

function domainSeen(domains, expectedDomain) {
  return domains.some((domain) => hostMatches(domain, expectedDomain));
}

function hostMatches(actual, expected) {
  const normalizedActual = String(actual || "").toLowerCase();
  const normalizedExpected = String(expected || "").toLowerCase();
  return (
    normalizedActual === normalizedExpected ||
    normalizedActual.endsWith(`.${normalizedExpected}`)
  );
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function getArg(args, keys) {
  for (const key of keys) {
    if (key in args) {
      return args[key];
    }
  }
  return undefined;
}

function loadDotEnv(envPath) {
  try {
    const content = readFileSync(envPath, "utf8");

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const delimiter = trimmed.indexOf("=");
      if (delimiter === -1) {
        continue;
      }

      const key = trimmed.slice(0, delimiter).trim();
      const value = trimmed.slice(delimiter + 1).trim();

      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional; provider may still be present in process env.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRunReport({ provider, goldenFile, startedAtMs, results, passedCount, failedCount }) {
  const durationMs = Date.now() - startedAtMs;
  const caseCount = results.length;
  const passRate = caseCount === 0 ? 0 : passedCount / caseCount;

  return {
    generatedAt: new Date().toISOString(),
    provider,
    goldenFile,
    caseCount,
    passedCount,
    failedCount,
    passRate,
    durationMs,
    cases: results.map((item) => ({
      name: item.name,
      query: item.query,
      pass: item.evaluation.pass,
      elapsedMs: item.elapsedMs,
      top1Domain: item.results[0]?.domain || null,
      topDomains: item.results.slice(0, 8).map((row) => row.domain),
      checks: item.evaluation.checks
    }))
  };
}

function writeReportFile(reportFile, report) {
  const absolutePath = path.isAbsolute(reportFile)
    ? reportFile
    : path.join(ROOT_DIR, reportFile);

  const outputDir = path.dirname(absolutePath);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
