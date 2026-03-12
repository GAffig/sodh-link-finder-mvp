import assert from "assert/strict";

import { resolveConfiguredProvider } from "../src/search/providers.js";

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function run() {
  await testFallsBackFromBraveToSerpApi();
  console.log("providers tests passed");
}

async function testFallsBackFromBraveToSerpApi() {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url) => {
    const href = String(url);
    calls.push(href);

    if (href.startsWith("https://api.search.brave.com/")) {
      return createJsonResponse(402, { error: { message: "payment required" } });
    }

    if (href.startsWith("https://serpapi.com/search.json")) {
      return createJsonResponse(200, {
        organic_results: [
          {
            title: "Median household income by county",
            link: "https://data.census.gov/table/example",
            snippet: "Census table"
          }
        ]
      });
    }

    throw new Error(`Unexpected URL: ${href}`);
  };

  try {
    const provider = resolveConfiguredProvider({
      BRAVE_API_KEY: "brave-test-key",
      SERPAPI_KEY: "serp-test-key"
    });

    const firstRows = await provider.searchWeb("median household income", { count: 5 });
    assert.equal(firstRows.length, 1);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].startsWith("https://api.search.brave.com/"));
    assert.ok(calls[1].startsWith("https://serpapi.com/search.json"));

    const secondRows = await provider.searchWeb("median household income", { count: 5 });
    assert.equal(secondRows.length, 1);
    assert.equal(calls.length, 3);
    assert.ok(calls[2].startsWith("https://serpapi.com/search.json"));
  } finally {
    global.fetch = originalFetch;
  }
}

function createJsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    }
  };
}
