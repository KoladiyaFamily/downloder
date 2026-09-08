/**
 * prod-vs-local-test.js — Local vs Production parity tester
 */
const https = require("https");
const http = require("http");

const PROD_URL  = process.env.PROD_URL  || "https://downloder-gxyi.onrender.com";
const LOCAL_URL = process.env.LOCAL_URL || "http://localhost:3001";
const PROD_ADMIN_EMAIL  = process.env.PROD_ADMIN_EMAIL  || process.env.ADMIN_EMAIL    || "";
const PROD_ADMIN_PASS   = process.env.PROD_ADMIN_PASS   || process.env.ADMIN_PASSWORD || "";
const LOCAL_ADMIN_EMAIL = process.env.LOCAL_ADMIN_EMAIL || "admin@test.local";
const LOCAL_ADMIN_PASS  = process.env.LOCAL_ADMIN_PASS  || "Admin@123456";
const TEST_URLS = [
  "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
  "https://youtu.be/eRTtU1znZI4"
];
let passed = 0, failed = 0;
function assert(name, condition, detail = "") {
  if (condition) { console.log(`OK PASS: ${name}`); passed++; }
  else { console.error(`FAIL: ${name}${detail ? " - " + detail : ""}`); failed++; }
}
function request(baseUrl, method, reqPath, body = null, headers = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(reqPath, baseUrl);
    const lib = fullUrl.protocol === "https:" ? https : http;
    const options = {
      hostname: fullUrl.hostname,
      port: fullUrl.port || (fullUrl.protocol === "https:" ? 443 : 80),
      path: fullUrl.pathname + fullUrl.search,
      method, headers: { ...headers }, timeout: timeoutMs,
    };
    let bodyData = null;
    if (body) {
      bodyData = JSON.stringify(body);
      options.headers["Content-Type"] = "application/json";
      options.headers["Content-Length"] = Buffer.byteLength(bodyData);
    }
    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ statusCode: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error(`Timeout ${timeoutMs}ms`)); });
    req.on("error", reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}
async function testEnv(label, baseUrl, email, pass) {
  console.log(`\n===== ${label.toUpperCase()} (${baseUrl}) =====\n`);
  const r = {};
  try {
    const res = await request(baseUrl, "GET", "/health", null, {}, 90000);
    r.health = res.statusCode;
    assert(`[${label}] /health 200`, res.statusCode === 200, `Status=${res.statusCode}`);
  } catch(e) { assert(`[${label}] /health 200`, false, e.message); r.health = 0; return r; }

  try {
    const res = await request(baseUrl, "GET", "/api/auth/me", null, {"x-test-enforce-auth":"true"});
    r.unauth = res.statusCode;
    assert(`[${label}] unauth /api/auth/me 401`, res.statusCode === 401);
  } catch(e) { assert(`[${label}] unauth /api/auth/me 401`, false, e.message); }

  let cookie = null;
  try {
    const res = await request(baseUrl, "POST", "/api/auth/login", { email, password: pass });
    r.loginStatus = res.statusCode; r.loginRole = res.json?.role;
    assert(`[${label}] login 200 role=admin`, res.statusCode === 200 && res.json?.role === "admin", res.raw.slice(0,200));
    if (res.statusCode === 200) {
      cookie = (res.headers["set-cookie"]||[]).map(c=>c.split(";")[0]).join("; ");
    }
  } catch(e) { assert(`[${label}] login 200`, false, e.message); }

  try {
    const h = cookie ? {Cookie:cookie} : {};
    const res = await request(baseUrl, "POST", "/api/info", {url:"http://169.254.169.254/latest"}, h);
    r.ssrf = res.statusCode;
    assert(`[${label}] SSRF blocked`, res.statusCode === 400 || res.statusCode === 429, `Status=${res.statusCode}`);
  } catch(e) { assert(`[${label}] SSRF blocked`, false, e.message); }

  r.info = {};
  for (const url of TEST_URLS) {
    try {
      const h = cookie ? {Cookie:cookie} : {};
      const res = await request(baseUrl, "POST", "/api/info", {url}, h, 90000);
      r.info[url] = { status: res.statusCode, title: res.json?.title };
      assert(`[${label}] /api/info OK: ${url.slice(0,50)}`,
        res.statusCode === 200 && res.json?.success && res.json?.title,
        `Status=${res.statusCode} title="${res.json?.title}" err="${res.json?.error}"`);
      if(res.json?.title) console.log(`   Title: "${res.json.title}", Qualities: ${(res.json.qualities||[]).map(q=>q.label).join(", ")}`);
    } catch(e) { assert(`[${label}] /api/info: ${url.slice(0,50)}`, false, e.message); r.info[url]={status:0}; }
  }
  return r;
}
async function main() {
  console.log("=".repeat(60));
  console.log("LOCAL vs PRODUCTION PARITY TEST");
  console.log("=".repeat(60));
  if (!PROD_ADMIN_EMAIL || !PROD_ADMIN_PASS) {
    console.warn("WARNING: PROD_ADMIN_EMAIL/PROD_ADMIN_PASS not set in env. Production auth tests may fail.");
  }
  const local = await testEnv("LOCAL", LOCAL_URL, LOCAL_ADMIN_EMAIL, LOCAL_ADMIN_PASS);
  const prod  = await testEnv("PROD",  PROD_URL,  PROD_ADMIN_EMAIL || LOCAL_ADMIN_EMAIL, PROD_ADMIN_PASS || LOCAL_ADMIN_PASS);

  console.log("\n===== PARITY COMPARISON =====\n");
  assert("Health: both 200", local.health === 200 && prod.health === 200, `L=${local.health} P=${prod.health}`);
  assert("Login: both 200 admin", local.loginStatus===200 && local.loginRole==="admin" && prod.loginStatus===200 && prod.loginRole==="admin",
    `L=${local.loginStatus}/${local.loginRole} P=${prod.loginStatus}/${prod.loginRole}`);
  assert("SSRF: both blocked", (local.ssrf===400||local.ssrf===429) && (prod.ssrf===400||prod.ssrf===429),
    `L=${local.ssrf} P=${prod.ssrf}`);
  for (const url of TEST_URLS) {
    assert(`Info parity: ${url.slice(0,50)}`,
      local.info[url]?.status===200 && prod.info[url]?.status===200,
      `L=${local.info[url]?.status}("${local.info[url]?.title}") P=${prod.info[url]?.status}("${prod.info[url]?.title}")`);
  }
  console.log(`\n===== RESULT: ${passed} PASSED, ${failed} FAILED =====\n`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch(e => { console.error("Fatal:", e); process.exit(1); });
