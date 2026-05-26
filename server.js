import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const CACHE_DIR = path.join(__dirname, "cache");
const LOG_DIR = path.join(__dirname, "logs");
const STOCKS_PATH = path.join(PUBLIC_DIR, "data", "stocks.json");
const APP_NAME = "StockMobile";

const TOKEN_SAFETY_MS = 60_000;
const DEFAULT_UNIVERSE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STOCK_TTL_MS = 30_000;

const CREDENTIAL_SCRIPT = `
$target = $env:STOCKMOBILE_CREDENTIAL_TARGET
$signature = @"
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class StockMobileCredentialReader {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

  [DllImport("Advapi32.dll", SetLastError = true)]
  public static extern bool CredFree(IntPtr credentialPtr);
}
"@
Add-Type $signature -ErrorAction SilentlyContinue | Out-Null
$ptr = [IntPtr]::Zero
if ([StockMobileCredentialReader]::CredRead($target, 1, 0, [ref]$ptr)) {
  try {
    $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][StockMobileCredentialReader+CREDENTIAL])
    if ($cred.CredentialBlob -ne [IntPtr]::Zero -and $cred.CredentialBlobSize -gt 0) {
      [Runtime.InteropServices.Marshal]::PtrToStringUni($cred.CredentialBlob, [int]($cred.CredentialBlobSize / 2))
    }
  } finally {
    [StockMobileCredentialReader]::CredFree($ptr) | Out-Null
  }
  exit 0
}
exit 1
`;

const DPAPI_DECRYPT_SCRIPT = `
$encrypted = $env:STOCKMOBILE_DPAPI_SECRET
$secure = ConvertTo-SecureString $encrypted
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
`;

const SENSITIVE_KEY_PATTERN = /(authorization|password|secret|token|app[_-]?key|key)/i;
const LISTED_PRODUCT_PATTERN = /^(1Q|ACE|ARIRANG|HANARO|KBSTAR|KIWOOM|KODEX|KOSEF|PLUS|RISE|SOL|TIMEFOLIO|TIGER)\b/i;

let dpapiSecrets;
let universeCache = { expiresAt: 0, data: null };
let tokenCache = null;
const stockMemoryCache = new Map();

await ensureRuntimeDirs();
const settings = await loadSettings();
const app = express();

app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(accessLogMiddleware);

app.get("/", (req, res) => {
  res.redirect(settings.basePath + "/");
});

app.get(settings.basePath, serveIndex);
app.get(settings.basePath + "/", serveIndex);
app.get(settings.basePath + "/index.html", serveIndex);
app.get(settings.basePath + "/api/health", (req, res) => {
  res.json({
    ok: true,
    basePath: settings.basePath,
    kiwoomConfigured: Boolean(settings.kiwoomAppKey && settings.kiwoomAppSecret),
    time: koreaIsoString()
  });
});
app.get(settings.basePath + "/api/search", handleSearch);
app.get(settings.basePath + "/api/stock/:code", handleStockDetail);
app.use(settings.basePath, express.static(PUBLIC_DIR, {
  dotfiles: "deny",
  etag: true,
  index: false,
  maxAge: "5m"
}));

app.use(settings.basePath + "/api", (req, res) => {
  res.status(404).json({ error: "API not found" });
});

app.use((req, res) => {
  if (req.path === settings.basePath || req.path.startsWith(settings.basePath + "/")) {
    res.status(404).send("Not found");
    return;
  }
  res.status(404).send("StockMobile is available under " + settings.basePath);
});

app.use(errorMiddleware);

app.listen(settings.port, settings.host, () => {
  appendLog("api.log", {
    event: "server-start",
    host: settings.host,
    port: settings.port,
    basePath: settings.basePath,
    kiwoomConfigured: Boolean(settings.kiwoomAppKey && settings.kiwoomAppSecret)
  });
  console.log(`StockMobile listening on http://${settings.host}:${settings.port}${settings.basePath}`);
});

function serveIndex(req, res, next) {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"), (error) => {
    if (error) next(error);
  });
}

async function handleSearch(req, res, next) {
  const startedAt = Date.now();
  const q = String(req.query.q || "").trim();
  const limit = clampNumber(Number(req.query.limit || 100), 1, 200);

  try {
    const universe = await loadUniverse();
    const results = searchUniverse(universe, q).slice(0, limit);
    appendLog("api.log", {
      event: "search",
      ip: clientIp(req),
      query: q,
      count: results.length,
      cache: "universe-memory",
      durationMs: Date.now() - startedAt
    });
    res.json({ query: q, count: results.length, results });
  } catch (error) {
    appendLog("api.log", {
      event: "search",
      ip: clientIp(req),
      query: q,
      externalSuccess: false,
      error: error.message,
      durationMs: Date.now() - startedAt
    });
    next(error);
  }
}

async function handleStockDetail(req, res, next) {
  const startedAt = Date.now();
  const code = normalizeStockCode(req.params.code);

  if (!/^[0-9A-Z]{5,8}$/.test(code)) {
    res.status(400).json({ error: "Invalid stock code" });
    return;
  }

  try {
    const result = await getStockDetail(code);
    appendLog("api.log", {
      event: "stock-detail",
      ip: clientIp(req),
      code,
      cache: result.cache,
      externalSuccess: result.externalSuccess,
      durationMs: Date.now() - startedAt
    });
    res.setHeader("X-StockMobile-Cache", result.cache);
    res.json(result.data);
  } catch (error) {
    appendLog("api.log", {
      event: "stock-detail",
      ip: clientIp(req),
      code,
      cache: "miss",
      externalSuccess: false,
      error: error.message,
      durationMs: Date.now() - startedAt
    });
    next(error);
  }
}

async function getStockDetail(code) {
  const now = Date.now();
  const memory = stockMemoryCache.get(code);
  if (memory && memory.expiresAt > now) {
    return { data: memory.data, cache: "memory", externalSuccess: null };
  }

  const disk = await readStockDiskCache(code);
  if (disk && disk.expiresAt > now) {
    stockMemoryCache.set(code, disk);
    return { data: disk.data, cache: "disk", externalSuccess: null };
  }

  const data = await fetchStockFromKiwoom(code);
  const cacheEntry = {
    createdAt: now,
    expiresAt: now + settings.stockCacheTtlMs,
    data
  };
  stockMemoryCache.set(code, cacheEntry);
  await writeStockDiskCache(code, cacheEntry);
  return { data, cache: "miss", externalSuccess: true };
}

async function fetchStockFromKiwoom(code) {
  if (!settings.kiwoomAppKey || !settings.kiwoomAppSecret) {
    const error = new Error("Kiwoom credentials are not configured.");
    error.status = 503;
    throw error;
  }

  const universe = await loadUniverse().catch(() => []);
  const stock = universe.find((item) => item.code === code);
  const tokenInfo = await getKiwoomToken();
  const response = await kiwoomPost(tokenInfo.baseUrl, settings.kiwoomStockInfoPath, settings.kiwoomQuoteApiId, tokenInfo.token, {
    stk_cd: code
  });
  const quote = response.data.output || response.data.data || response.data.quote || response.data;
  const marketCapRaw = parseNumber(firstValue(quote, ["marketCap", "mac", "market_cap", "시가총액"]));

  return {
    code,
    name: String(firstValue(quote, ["stockName", "stk_nm", "name"]) || stock?.name || code),
    price: parseAbsoluteNumber(firstValue(quote, ["price", "cur_prc", "currentPrice", "stck_prpr", "now"])),
    per: parseNumber(firstValue(quote, ["per", "PER"])),
    pbr: parseNumber(firstValue(quote, ["pbr", "PBR"])),
    marketCap: normalizeMarketCap(marketCapRaw),
    changeRate: parseNumber(firstValue(quote, ["changeRate", "flu_rt", "prdy_ctrt", "rate"])),
    updatedAt: koreaIsoString()
  };
}

async function getKiwoomToken() {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + TOKEN_SAFETY_MS) return tokenCache;

  const errors = [];
  for (const baseUrl of settings.kiwoomBaseUrls) {
    try {
      const response = await fetch(new URL(settings.kiwoomTokenPath, baseUrl + "/"), {
        method: "POST",
        headers: { "Content-Type": "application/json;charset=UTF-8" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          appkey: settings.kiwoomAppKey,
          secretkey: settings.kiwoomAppSecret
        })
      });
      const text = await response.text();
      if (!response.ok) {
        errors.push(`${baseUrl}: HTTP ${response.status}`);
        continue;
      }
      const data = JSON.parse(text || "{}");
      const token = data.token || data.access_token;
      if (!token) {
        errors.push(`${baseUrl}: ${data.return_msg || "token missing"}`);
        continue;
      }
      const expiresAt = tokenExpiresAt(data);
      tokenCache = { token, baseUrl, expiresAt };
      return tokenCache;
    } catch (error) {
      errors.push(`${baseUrl}: ${error.message}`);
    }
  }

  const error = new Error(`Kiwoom auth failed: ${errors.join(" | ")}`);
  error.status = 502;
  throw error;
}

async function kiwoomPost(baseUrl, apiPath, apiId, token, body) {
  const response = await fetch(new URL(apiPath, baseUrl + "/"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      authorization: token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`,
      "api-id": apiId
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`Kiwoom ${apiId} HTTP ${response.status}`);
    error.status = 502;
    throw error;
  }
  const data = JSON.parse(text || "{}");
  if (data.return_code !== undefined && Number(data.return_code) !== 0) {
    const error = new Error(`Kiwoom ${apiId} ${data.return_code}: ${data.return_msg || "request failed"}`);
    error.status = 502;
    throw error;
  }
  return { data };
}

async function loadUniverse() {
  const now = Date.now();
  if (universeCache.data && universeCache.expiresAt > now) return universeCache.data;

  const raw = await fsp.readFile(STOCKS_PATH, "utf8");
  const data = JSON.parse(raw);
  const universe = (data.allStocks || data.stocks || [])
    .map((item) => ({
      code: normalizeStockCode(item.code),
      name: String(item.name || item.code || "").trim(),
      market: String(item.market || "").trim()
    }))
    .filter((item) => item.code && item.name);

  universeCache = {
    data: universe,
    expiresAt: now + settings.universeCacheTtlMs
  };
  return universe;
}

function searchUniverse(universe, keyword) {
  const normalized = normalizeKeyword(keyword);
  if (!normalized) return [];
  return universe
    .filter((stock) => {
      const name = stock.name.toLowerCase();
      const code = stock.code.toLowerCase();
      const label = stockLabel(stock).toLowerCase();
      return name.includes(normalized) || code.includes(normalized) || label.includes(normalized);
    })
    .sort((a, b) => compareSearchResult(a, b, normalized));
}

async function readStockDiskCache(code) {
  try {
    const raw = await fsp.readFile(stockCachePath(code), "utf8");
    const entry = JSON.parse(raw);
    if (!entry || !entry.data || !entry.expiresAt) return null;
    return entry;
  } catch {
    return null;
  }
}

async function writeStockDiskCache(code, entry) {
  await fsp.writeFile(stockCachePath(code), JSON.stringify(entry), "utf8");
}

function stockCachePath(code) {
  return path.join(CACHE_DIR, `stock-${normalizeStockCode(code)}.json`);
}

async function loadSettings() {
  const basePath = normalizeBasePath(await configValue("STOCKMOBILE_BASE_PATH", "/stockmobile"));
  const kiwoomBaseUrls = parseBaseUrls(
    await configValue("KIWOOM_BASE_URLS", "", { secret: true }) ||
    await configValue("KIWOOM_BASE_URL", "", { secret: true }) ||
    "https://api.kiwoom.com,https://mockapi.kiwoom.com"
  );

  return {
    host: await configValue("STOCKMOBILE_HOST", "127.0.0.1"),
    port: clampNumber(Number(await configValue("PORT", "3100")), 1, 65535),
    basePath,
    universeCacheTtlMs: clampNumber(Number(await configValue("STOCKMOBILE_UNIVERSE_CACHE_SECONDS", "86400")), 60, 604800) * 1000,
    stockCacheTtlMs: clampNumber(Number(await configValue("STOCKMOBILE_STOCK_CACHE_SECONDS", "30")), 10, 600) * 1000,
    kiwoomAppKey: await configValue("KIWOOM_APP_KEY", "", { secret: true }),
    kiwoomAppSecret: await configValue("KIWOOM_APP_SECRET", "", { secret: true }) || await configValue("KIWOOM_SECRET_KEY", "", { secret: true }),
    kiwoomBaseUrls,
    kiwoomTokenPath: await configValue("KIWOOM_TOKEN_PATH", "/oauth2/token", { secret: true }),
    kiwoomStockInfoPath: await configValue("KIWOOM_STOCK_INFO_PATH", "/api/dostk/stkinfo", { secret: true }),
    kiwoomQuoteApiId: await configValue("KIWOOM_QUOTE_API_ID", "ka10001", { secret: true })
  };
}

async function configValue(name, fallback, options = {}) {
  const envValue = process.env[name];
  if (envValue !== undefined && envValue !== "") return envValue;
  if (!options.secret) return fallback;

  const dpapiValue = await readDpapiSecret(name);
  if (dpapiValue) return dpapiValue;

  const credentialValue = readWindowsCredential(name);
  if (credentialValue) return credentialValue;

  return fallback;
}

async function readDpapiSecret(name) {
  const secrets = await loadDpapiSecrets();
  const encrypted = secrets?.[name];
  if (!encrypted || process.platform !== "win32") return "";
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", DPAPI_DECRYPT_SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, STOCKMOBILE_DPAPI_SECRET: encrypted },
      windowsHide: true,
      timeout: 10_000
    }).trim();
  } catch {
    return "";
  }
}

async function loadDpapiSecrets() {
  if (dpapiSecrets !== undefined) return dpapiSecrets;
  const candidates = [
    process.env.STOCKMOBILE_DPAPI_SECRET_FILE,
    path.join(__dirname, "secrets", "stockmobile.dpapi.json"),
    path.join(__dirname, "config", "stockmobile.dpapi.json")
  ].filter(Boolean);

  for (const file of candidates) {
    try {
      dpapiSecrets = JSON.parse(await fsp.readFile(file, "utf8"));
      return dpapiSecrets;
    } catch {
      // Try the next location.
    }
  }

  dpapiSecrets = null;
  return dpapiSecrets;
}

function readWindowsCredential(name) {
  if (process.platform !== "win32") return "";
  const targets = [`${APP_NAME}/${name}`, `${APP_NAME}:${name}`, name];
  for (const target of targets) {
    try {
      const value = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", CREDENTIAL_SCRIPT], {
        encoding: "utf8",
        env: { ...process.env, STOCKMOBILE_CREDENTIAL_TARGET: target },
        windowsHide: true,
        timeout: 10_000
      }).trim();
      if (value) return value;
    } catch {
      // Missing credential or unavailable API. Try the next target.
    }
  }
  return "";
}

function accessLogMiddleware(req, res, next) {
  const startedAt = Date.now();
  res.on("finish", () => {
    appendLog("access.log", {
      ip: clientIp(req),
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - startedAt
    });
  });
  next();
}

function errorMiddleware(error, req, res, next) {
  if (res.headersSent) {
    next(error);
    return;
  }
  const status = error.status && Number(error.status) >= 400 ? Number(error.status) : 500;
  appendLog("error.log", {
    ip: clientIp(req),
    method: req.method,
    path: req.originalUrl,
    status,
    message: error.message
  });
  res.status(status).json({
    error: status >= 500 ? "Stock detail service error" : error.message
  });
}

function appendLog(fileName, data) {
  const line = JSON.stringify(sanitizeLog({ time: koreaIsoString(), ...data })) + "\n";
  fs.appendFile(path.join(LOG_DIR, fileName), line, () => {});
}

function sanitizeLog(value) {
  if (Array.isArray(value)) return value.map(sanitizeLog);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : sanitizeLog(item)
  ]));
}

async function ensureRuntimeDirs() {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  await fsp.mkdir(LOG_DIR, { recursive: true });
}

function clientIp(req) {
  return req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
}

function normalizeBasePath(value) {
  const trimmed = String(value || "/stockmobile").trim();
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "") || "/stockmobile";
}

function parseBaseUrls(value) {
  return String(value)
    .split(",")
    .map((url) => url.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function normalizeKeyword(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeStockCode(value) {
  return String(value || "").trim().toUpperCase().replace(/^A(?=\d{6}$)/, "");
}

function stockLabel(stock) {
  return `${stock.name} (${stock.code})`;
}

function matchRank(stock, keyword) {
  const name = stock.name.toLowerCase();
  const code = stock.code.toLowerCase();
  if (name === keyword || code === keyword || stockLabel(stock).toLowerCase() === keyword) return 0;
  if (name.startsWith(keyword)) return 1;
  if (code.startsWith(keyword)) return 2;
  return 3;
}

function marketRank(stock) {
  const market = String(stock.market || "").toUpperCase();
  const name = String(stock.name || "").toUpperCase();
  const isListedProduct = name.includes("ETN") ||
    name.includes("ETF") ||
    LISTED_PRODUCT_PATTERN.test(name);
  if (isListedProduct) return 2;
  if (market.includes("KOSPI") || market.includes("코스피")) return 0;
  if (market.includes("KOSDAQ") || market.includes("코스닥")) return 1;
  return 2;
}

function compareSearchResult(a, b, keyword) {
  const rankA = matchRank(a, keyword);
  const rankB = matchRank(b, keyword);
  if (rankA === 0 || rankB === 0) return rankA - rankB;
  return marketRank(a) - marketRank(b) ||
    rankA - rankB ||
    a.name.localeCompare(b.name, "ko") ||
    a.code.localeCompare(b.code);
}

function firstValue(source, keys) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source?.[key] !== null && source?.[key] !== "") return source[key];
  }
  return null;
}

function parseNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const cleaned = String(value).replace(/,/g, "").replace(/[+%]/g, "").trim();
  if (!cleaned || cleaned === "-") return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAbsoluteNumber(value) {
  const parsed = parseNumber(value);
  return parsed === null ? null : Math.abs(parsed);
}

function normalizeMarketCap(value) {
  if (value === null) return null;
  return Math.abs(value) < 1_000_000_000_000 ? Math.abs(value) * 100_000_000 : Math.abs(value);
}

function tokenExpiresAt(data) {
  if (data.expires_dt) {
    const parsed = Date.parse(String(data.expires_dt).replace(" ", "T"));
    if (Number.isFinite(parsed)) return parsed;
  }
  const seconds = Number(data.expires_in || data.expires || 3600);
  return Date.now() + clampNumber(seconds, 60, 86400) * 1000;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function koreaIsoString(date = new Date()) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().replace("Z", "+09:00");
}
