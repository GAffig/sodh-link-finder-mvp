import assert from "assert/strict";

import { cdcWonderExtractor } from "../src/extractors/cdc-wonder.js";
import { tnDeathStatsExtractor } from "../src/extractors/tn-death-stats.js";

run();

async function run() {
  await testCdcWonderTemplateExecution();
  await testTdhCatalogMode();
  await testTdhTidyCsvMode();
  console.log("extractors-behavior tests passed");
}

async function testCdcWonderTemplateExecution() {
  let called = false;
  const fetchImpl = async (url, options) => {
    called = true;
    assert.equal(url, "https://wonder.cdc.gov/controller/datarequest");
    assert.equal(options?.method, "POST");
    assert.match(String(options?.body || ""), /M_1=/);

    return createTextResponse({
      ok: true,
      status: 200,
      body: "Year,County,Deaths,State Code,County Code\n2023,Davidson,100,47,037\n"
    });
  };

  const output = await cdcWonderExtractor.extract({
    url: "https://wonder.cdc.gov/",
    parameters: {
      templateId: "mortality_county_v1",
      geographyType: "county",
      year: 2023
    },
    fetchImpl
  });

  assert.equal(called, true);
  assert.equal(output.source, "cdc_wonder");
  assert.equal(output.rows.length, 1);
  assert.equal(output.rows[0].data_year, 2023);
  assert.equal(output.rows[0].geography_name, "Davidson");
  assert.equal(output.rows[0].value, 100);
}

async function testTdhCatalogMode() {
  const indexUrl =
    "https://www.tn.gov/health/health-program-areas/statistics/health-data/death-statistics.html";

  const html = `
    <html>
      <body>
        <a href="/content/dam/tn/health/documents/death/Death_Statistics_2023_County.xlsx">
          Death statistics county 2023
        </a>
        <a href="/content/dam/tn/health/documents/death/Death_Statistics_2022_State.pdf">
          Death statistics state 2022
        </a>
      </body>
    </html>
  `;

  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.equal(url, indexUrl);
    return createTextResponse({ ok: true, status: 200, body: html });
  };

  const output = await tnDeathStatsExtractor.extract({
    url: indexUrl,
    parameters: { mode: "catalog" },
    fetchImpl,
    caches: {
      linkCatalogStore: new Map(),
      linkCatalogTtlMs: 60_000
    }
  });

  assert.equal(calls, 1);
  assert.equal(output.method, "download_index");
  assert.equal(output.rows.length, 2);
  assert.equal(output.rows[0].source, "tdh_death_stats");
}

async function testTdhTidyCsvMode() {
  const indexUrl =
    "https://www.tn.gov/health/health-program-areas/statistics/health-data/death-statistics.html";
  const csvUrl = "https://www.tn.gov/content/dam/tn/health/documents/death/death-rates-2023.csv";

  const html = `<a href="${csvUrl}">Death rates by county 2023</a>`;
  const csvBody = [
    "County,Year,Death Rate",
    "Davidson,2023,7.2",
    "Shelby,2023,8.1"
  ].join("\n");

  const fetchImpl = async (url) => {
    if (url === indexUrl) {
      return createTextResponse({ ok: true, status: 200, body: html });
    }
    if (url === csvUrl) {
      return createTextResponse({ ok: true, status: 200, body: csvBody });
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const output = await tnDeathStatsExtractor.extract({
    url: indexUrl,
    parameters: {
      mode: "tidy",
      sectionContains: "death rates",
      maxFiles: 1
    },
    fetchImpl,
    caches: {
      linkCatalogStore: new Map(),
      linkCatalogTtlMs: 60_000
    }
  });

  assert.equal(output.method, "download_index_tidy");
  assert.equal(output.rows.length, 2);
  assert.equal(output.rows[0].geography_name, "Davidson");
  assert.equal(output.rows[0].data_year, 2023);
  assert.equal(output.rows[0].value, 7.2);
}

function createTextResponse({ ok, status, body }) {
  const text = String(body || "");
  return {
    ok,
    status,
    async text() {
      return text;
    },
    async arrayBuffer() {
      return Buffer.from(text, "utf8");
    }
  };
}
