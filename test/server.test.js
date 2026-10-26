const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const Module = require("node:module");
const path = require("node:path");
const fs = require("node:fs");

const testApiKey = "node-test-only-not-a-real-api-key";
const originalApiKey = process.env.GEMINI_API_KEY;
process.env.GEMINI_API_KEY = testApiKey;

let mockMode = "success";
let lastRequest = null;
let sdkCallCount = 0;
const capturedLogs = [];
const originalConsole = {
  info: console.info,
  error: console.error,
  log: console.log
};

for (const method of Object.keys(originalConsole)) {
  console[method] = (...args) => capturedLogs.push(args.map(String).join(" "));
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@google/genai") {
    return {
      GoogleGenAI: class MockGoogleGenAI {
        constructor(options) {
          this.options = options;
          this.models = {
            generateContent: async (requestOptions) => {
              sdkCallCount += 1;
              lastRequest = requestOptions;

              if (mockMode === "never-resolves") {
                return new Promise(() => {});
              }

              if (mockMode === "timeout") {
                const error = new Error("Mock Gemini request timed out");
                error.name = "AbortError";
                throw error;
              }

              if (mockMode === "malformed") {
                return { text: "not valid JSON" };
              }

              if (mockMode === "unexpected-error") {
                throw new Error("Unexpected mocked provider failure");
              }

              if (mockMode === "success" || mockMode === "success-high") {
                return {
                  text: JSON.stringify({
                    status: mockMode === "success-high" ? "High Risk" : "Medium Risk",
                    signals: [
                      {
                        title: "Urgency",
                        explanation: "The message asks the reader to act today."
                      }
                    ],
                    explanation: "The deadline deserves independent verification.",
                    summary: "Verify this request before responding."
                  })
                };
              }

              const providerErrors = {
                quota: {
                  code: 429,
                  status: "RESOURCE_EXHAUSTED",
                  message: "Quota exceeded"
                },
                unavailable: {
                  code: 503,
                  status: "UNAVAILABLE",
                  message: "Provider unavailable"
                }
              };
              const details = providerErrors[mockMode];
              const error = new Error(JSON.stringify({ error: details }));
              error.status = details.code;
              throw error;
            }
          };
        }
      }
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

const app = require("../server.js");
Module._load = originalLoad;

const frontendPath = path.join(__dirname, "..", "index.html");
const frontendHtml = fs.readFileSync(frontendPath, "utf8");
const expectedFallbackLabel = "Basic rule-based analysis — Gemini unavailable";
const suspiciousMessage =
  "URGENT: Your student account expires immediately. Reply with your password and pay the processing fee at http://login.paypal.example.com/verify";
const accountThreatMessage =
  "URGENT: Your bank account will be suspended in 10 minutes! Verify your password immediately to prevent your account from being blocked.";
const harmlessMessage =
  "Hi, our study group meeting moved to 3 PM in the library. See you there!";

let server;
let baseUrl;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  for (const method of Object.keys(originalConsole)) {
    console[method] = originalConsole[method];
  }

  if (originalApiKey === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = originalApiKey;
  }
});

async function postAnalysis(body, raw = false) {
  return fetch(`${baseUrl}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body)
  });
}

function assertFrontendCompatible(result) {
  assert.ok(["High Risk", "Medium Risk", "Low Risk"].includes(result.status));
  assert.ok(Array.isArray(result.signals));
  assert.ok(result.signals.every((signal) =>
    typeof signal.title === "string" &&
    typeof signal.explanation === "string"
  ));
  assert.equal(typeof result.explanation, "string");
  assert.equal(typeof result.summary, "string");
  assert.ok(Array.isArray(result.recommendations));
  assert.ok(Array.isArray(result.urls));
  assert.ok(["gemini", "rule-based-fallback"].includes(result.analysisSource));
  assert.equal(typeof result.analysisLabel, "string");
  assert.ok(result.urls.every((url) =>
    typeof url.url === "string" &&
    typeof url.host === "string" &&
    Array.isArray(url.signals) &&
    typeof url.verification === "string"
  ));
}

test("health endpoint reports server readiness without revealing credentials", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.status, "ok");
  assert.equal(result.message, "PhishProof AI server is running.");
  assert.equal(result.aiConfigured, true);
  assert.equal(JSON.stringify(result).includes(testApiKey), false);
});

test("empty and invalid analysis inputs return JSON client errors", async () => {
  const empty = await postAnalysis({ message: "  " });
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /enter a message/i);

  const invalidType = await postAnalysis({ message: 42 });
  assert.equal(invalidType.status, 400);
  assert.equal(typeof (await invalidType.json()).error, "string");

  const tooLong = await postAnalysis({ message: "x".repeat(10001) });
  assert.equal(tooLong.status, 413);
  assert.match((await tooLong.json()).error, /10,?000/);

  const malformedJson = await postAnalysis("{", true);
  assert.equal(malformedJson.status, 400);
  assert.equal(typeof (await malformedJson.json()).error, "string");
});

test("Gemini success response matches the frontend schema and source label", async () => {
  mockMode = "success";
  const response = await postAnalysis({ message: suspiciousMessage });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.analysisSource, "gemini");
  assert.equal(result.analysisLabel, "Gemini AI analysis");
  assertFrontendCompatible(result);
  assert.equal(lastRequest.model, "gemini-3.8-flash");
  assert.match(frontendHtml, /analysisSourceNotice/);
  assert.match(frontendHtml, /!\["gemini", "rule-based-fallback"\]\.includes\(data\.analysisSource\)/);
});

test("Gemini High Risk status is passed through without being downgraded", async () => {
  mockMode = "success-high";
  const response = await postAnalysis({ message: accountThreatMessage });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.status, "High Risk");
  assert.equal(result.analysisSource, "gemini");
  assert.equal(result.analysisLabel, "Gemini AI analysis");
});

test("urgent credential requests with account threats are classified High Risk by fallback rules", async () => {
  mockMode = "quota";
  const response = await postAnalysis({ message: accountThreatMessage });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.status, "High Risk");
  assert.equal(result.analysisSource, "rule-based-fallback");
  assert.ok(result.signals.some((signal) => /urgency/i.test(signal.title)));
  assert.ok(result.signals.some((signal) => /credential/i.test(signal.title)));
  assert.ok(result.signals.some((signal) => /suspension/i.test(signal.title)));
});

test("quota errors use a clearly labelled fallback with supported warning signs", async () => {
  mockMode = "quota";
  const response = await postAnalysis({ message: suspiciousMessage });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.analysisSource, "rule-based-fallback");
  assert.equal(result.analysisLabel, expectedFallbackLabel);
  assert.match(result.note, /quota/i);
  assertFrontendCompatible(result);
  assert.ok(result.signals.some((signal) => /urgency/i.test(signal.title)));
  assert.ok(result.signals.some((signal) => /credential|account/i.test(signal.title)));
  assert.ok(result.signals.some((signal) => /payment/i.test(signal.title)));
  assert.ok(result.signals.some((signal) => /URL formatting/i.test(signal.title)));
  assert.ok(result.signals.every((signal) => signal.explanation.length > 0));
});

test("HTTP 503 errors use the rule-based fallback", async () => {
  mockMode = "unavailable";
  const response = await postAnalysis({ message: suspiciousMessage });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.analysisSource, "rule-based-fallback");
  assert.equal(result.analysisLabel, expectedFallbackLabel);
  assert.match(result.note, /temporarily unavailable/i);
  assertFrontendCompatible(result);
});

test("Gemini timeout errors return a fallback instead of leaving the request pending", async () => {
  mockMode = "timeout";
  const response = await postAnalysis({ message: suspiciousMessage });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.analysisSource, "rule-based-fallback");
  assert.equal(result.analysisLabel, expectedFallbackLabel);
  assert.match(result.note, /timed out/i);
  assertFrontendCompatible(result);
});

test("a Gemini promise that never settles is bounded by the server watchdog", async () => {
  mockMode = "never-resolves";
  const startedAt = Date.now();
  const response = await postAnalysis({ message: suspiciousMessage });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.analysisSource, "rule-based-fallback");
  assert.equal(result.analysisLabel, expectedFallbackLabel);
  assert.match(result.note, /timed out/i);
  assert.ok(Date.now() - startedAt < 28000);
  assertFrontendCompatible(result);
});

test("harmless text is not automatically classified as phishing by fallback rules", async () => {
  mockMode = "quota";
  const response = await postAnalysis({ message: harmlessMessage });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.analysisSource, "rule-based-fallback");
  assert.equal(result.status, "Low Risk");
  assert.deepEqual(result.signals, []);
  assert.match(result.summary, /not confirmation|inconclusive/i);
});

test("malformed Gemini output and unexpected provider errors return safe JSON errors", async () => {
  mockMode = "malformed";
  let response = await postAnalysis({ message: suspiciousMessage });
  let result = await response.json();
  assert.equal(response.status, 502);
  assert.equal(typeof result.error, "string");

  mockMode = "unexpected-error";
  response = await postAnalysis({ message: suspiciousMessage });
  result = await response.json();
  assert.equal(response.status, 502);
  assert.equal(typeof result.error, "string");
});

test("API key and submitted message are absent from server logs and frontend source", async () => {
  mockMode = "quota";
  const privateSample =
    "private-test-message-content used solely to test safe logging";
  await postAnalysis({ message: privateSample });

  const logs = capturedLogs.join("\n");
  assert.equal(logs.includes(testApiKey), false);
  assert.equal(logs.includes(privateSample), false);
  assert.equal(/AIza[0-9A-Za-z_-]{20,}|GEMINI_API_KEY/.test(frontendHtml), false);
});
