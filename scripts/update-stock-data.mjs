import fs from "fs";
import AdmZip from "adm-zip";

const DART_KEY = process.env.OPENDART_API_KEY;
const KIWOOM_APP_KEY = process.env.KIWOOM_APP_KEY;
const KIWOOM_APP_SECRET = process.env.KIWOOM_APP_SECRET || process.env.KIWOOM_SECRET_KEY;
const KIWOOM_BASE_URL = process.env.KIWOOM_BASE_URL || "https://api.kiwoom.com";
const KIWOOM_TOKEN_PATH = process.env.KIWOOM_TOKEN_PATH || "/oauth2/token";
const KIWOOM_STOCK_INFO_PATH = process.env.KIWOOM_STOCK_INFO_PATH || process.env.KIWOOM_STOCK_LIST_PATH || "/api/dostk/stkinfo";
const KIWOOM_STOCK_LIST_API_ID = process.env.KIWOOM_STOCK_LIST_API_ID || "ka10099";
const KIWOOM_QUOTE_API_ID = process.env.KIWOOM_QUOTE_API_ID || "ka10001";
const KIWOOM_MAX_CONTINUATIONS = Number(process.env.KIWOOM_MAX_CONTINUATIONS || process.env.KIWOOM_MAX_PAGES || 20);
const KIWOOM_MARKET_ALIASES = {
  KOSPI: { code: "0", label: "KOSPI" },
  "0": { code: "0", label: "KOSPI" },
  KOSDAQ: { code: "10", label: "KOSDAQ" },
  "10": { code: "10", label: "KOSDAQ" },
  ETF: { code: "8", label: "ETF" },
  "8": { code: "8", label: "ETF" },
  ETN: { code: "60", label: "ETN" },
  "60": { code: "60", label: "ETN" }
};
const KIWOOM_MARKETS = parseKiwoomMarkets(process.env.KIWOOM_MARKETS || "0:KOSPI,10:KOSDAQ");
const STOCK_LIST_PATH = "data/stock-list.json";
const OUTPUT_PATH = "data/stocks.json";
const REPORTS = [
  { code: "11013", month: "03" },
  { code: "11012", month: "06" },
  { code: "11014", month: "09" },
  { code: "11011", month: "12" }
];
const ALIASES = {
  revenue: ["매출액", "수익(매출액)", "영업수익", "매출", "수익"],
  operatingProfit: ["영업이익", "영업이익(손실)"],
  netIncome: ["당기순이익", "당기순이익(손실)", "분기순이익", "반기순이익"],
  liabilities: ["부채총계"],
  equity: ["자본총계"],
  eps: ["기본주당이익", "기본주당순이익", "주당이익"]
};

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function parseKiwoomMarkets(value) {
  return String(value)
    .split(",")
    .map((raw) => {
      const [market, label] = raw.split(":").map((part) => part.trim());
      const known = KIWOOM_MARKET_ALIASES[market?.toUpperCase()];
      return {
        code: known?.code || market,
        label: label || known?.label || market
      };
    })
    .filter((market) => market.code);
}
function toNumber(value) {
  if (value === null || value === undefined) return "-";
  const cleaned = String(value).replace(/,/g, "").replace(/원/g, "").replace(/%/g, "").trim();
  if (!cleaned || cleaned === "-" || cleaned === "N/A") return "-";
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : "-";
}
function formatWon(won) {
  const n = toNumber(won);
  if (n === "-") return "-";
  const eok = Math.round(n / 100000000);
  if (eok >= 10000) {
    const jo = Math.floor(eok / 10000);
    const rest = eok % 10000;
    return rest ? `${jo}조 ${rest.toLocaleString("ko-KR")}억` : `${jo}조`;
  }
  return `${eok.toLocaleString("ko-KR")}억`;
}
function plain(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}
function byId(html, id) {
  const re = new RegExp(`id=["']${id}["'][^>]*>([\\s\\S]*?)<`, "i");
  const m = html.match(re);
  return m ? toNumber(m[1].replace(/<[^>]+>/g, "")) : "-";
}
function byLabel(html, label) {
  const text = plain(html);
  const idx = text.indexOf(label);
  if (idx < 0) return "-";
  const m = text.slice(idx, idx + 300).match(/(-?\d[\d,]*\.?\d*)\s*(?:%|배|원)?/);
  return m ? toNumber(m[1]) : "-";
}
async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 GitHubActions StockDataBot",
      "Accept": "text/html,application/json,*/*",
      "Referer": "https://finance.naver.com/"
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return await response.text();
}
async function fetchNaver(code) {
  const html = await fetchText(`https://finance.naver.com/item/main.naver?code=${code}`);
  const currentPrice = byId(html, "_nowVal");
  const changeRate = byId(html, "_rate");
  const per = byId(html, "_per") !== "-" ? byId(html, "_per") : byLabel(html, "PER");
  const pbr = byId(html, "_pbr") !== "-" ? byId(html, "_pbr") : byLabel(html, "PBR");
  const dividendYield = byLabel(html, "배당수익률");
  const marketCap = byLabel(html, "시가총액");
  return {
    currentPrice,
    changeRate,
    metrics: {
      per,
      pbr,
      marketCap: marketCap === "-" ? "-" : `${marketCap.toLocaleString("ko-KR")}억`,
      dividendYield
    }
  };
}
async function kiwoomRestToken() {
  if (!KIWOOM_APP_KEY || !KIWOOM_APP_SECRET) return null;
  const response = await fetch(`${KIWOOM_BASE_URL}${KIWOOM_TOKEN_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: KIWOOM_APP_KEY,
      secretkey: KIWOOM_APP_SECRET
    })
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Kiwoom token HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  const data = await response.json();
  const token = data.token || data.access_token || null;
  if (!token) throw new Error(`Kiwoom token missing in response${data.return_msg ? `: ${data.return_msg}` : ""}`);
  return token;
}
function kiwoomRestAuthorization(token) {
  return String(token).toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
}
async function kiwoomRestPost(path, apiId, token, body = {}, continuation = {}) {
  if (!token) throw new Error("Kiwoom token missing");

  const url = new URL(`${KIWOOM_BASE_URL}${path}`);
  const headers = {
    "Content-Type": "application/json;charset=UTF-8",
    authorization: kiwoomRestAuthorization(token),
    "api-id": apiId
  };
  if (continuation.contYn) headers["cont-yn"] = continuation.contYn;
  if (continuation.nextKey) headers["next-key"] = continuation.nextKey;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Kiwoom HTTP ${response.status}: ${apiId} ${text.slice(0, 200)}`);

  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Kiwoom ${apiId} invalid JSON: ${text.slice(0, 200)}`);
    }
  }
  if (data.return_code !== undefined && Number(data.return_code) !== 0) {
    throw new Error(`Kiwoom ${apiId} ${data.return_code}: ${data.return_msg || "request failed"}`);
  }

  return {
    data,
    contYn: response.headers.get("cont-yn") || data["cont-yn"] || data.cont_yn || "",
    nextKey: response.headers.get("next-key") || data["next-key"] || data.next_key || ""
  };
}
function extractKiwoomRestList(data) {
  const candidates = [data.list, data.stk_info, data.stk_list, data.stocks, data.output, data.items, data.data];
  return candidates.find((candidate) => Array.isArray(candidate)) || [];
}
function normalizeKiwoomRestCode(value) {
  return String(value || "").trim().replace(/^A(?=\d{6}$)/, "");
}
function normalizeKiwoomRestUniverseItem(item, fallbackMarket = "") {
  const code = normalizeKiwoomRestCode(item.code || item.stk_cd || item.iscd || item.stock_code || item.item_cd);
  const name = String(item.name || item.stk_nm || item.hts_kor_isnm || item.stock_name || item.item_nm || "").trim();
  const market = String(item.market || item.mrkt || item.market_type || item.mrkt_tp || fallbackMarket).trim();
  if (!code || !name) return null;
  return { code, name, market };
}
async function fetchKiwoomUniverseRest(token) {
  if (!token) return [];

  const merged = new Map();
  for (const market of KIWOOM_MARKETS) {
    let contYn = "N";
    let nextKey = "";
    let continuationCount = 0;

    do {
      const result = await kiwoomRestPost(KIWOOM_STOCK_INFO_PATH, KIWOOM_STOCK_LIST_API_ID, token, {
        mrkt_tp: market.code
      }, { contYn, nextKey });
      const list = extractKiwoomRestList(result.data);
      if (!Array.isArray(list) || list.length === 0) break;

      for (const item of list.map((raw) => normalizeKiwoomRestUniverseItem(raw, market.label)).filter(Boolean)) {
        if (!merged.has(item.code)) merged.set(item.code, item);
      }

      contYn = String(result.contYn || "").toUpperCase() === "Y" ? "Y" : "N";
      nextKey = result.nextKey || "";
      continuationCount += 1;
      if (contYn === "Y" && nextKey) await sleep(120);
    } while (contYn === "Y" && nextKey && continuationCount < KIWOOM_MAX_CONTINUATIONS);
  }

  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name, "ko"));
}
async function fetchKiwoomQuoteRest(code, token) {
  if (!token) return null;
  const { data } = await kiwoomRestPost(KIWOOM_STOCK_INFO_PATH, KIWOOM_QUOTE_API_ID, token, { stk_cd: code });
  const quote = data.output || data.data || data.quote || data;
  const currentPrice = toNumber(quote.currentPrice || quote.cur_prc || quote.stck_prpr || quote.price || quote.now || "-");
  const changeRate = toNumber(quote.changeRate || quote.flu_rt || quote.prdy_ctrt || quote.rate || "-");
  const per = toNumber(quote.per || quote.PER || "-");
  const pbr = toNumber(quote.pbr || quote.PBR || "-");
  const marketCap = toNumber(quote.marketCap || quote.mac || quote.market_cap || "-");
  const dividendYield = toNumber(quote.dividendYield || quote.dvyy || quote.dvdd_yld || "-");
  return {
    currentPrice,
    changeRate,
    metrics: {
      per,
      pbr,
      marketCap: marketCap === "-" ? "-" : `${marketCap.toLocaleString("ko-KR")}억`,
      dividendYield
    }
  };
}
async function dartJson(path, params) {
  if (!DART_KEY) throw new Error("OPENDART_API_KEY secret이 없습니다.");
  const url = new URL(`https://opendart.fss.or.kr/api/${path}`);
  url.searchParams.set("crtfc_key", DART_KEY);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`OpenDART HTTP ${response.status}`);
  const data = await response.json();
  if (data.status && !["000", "013"].includes(data.status)) throw new Error(`OpenDART ${data.status}: ${data.message}`);
  return data;
}
async function corpCodeFromDart(stockCode) {
  if (!DART_KEY) return null;
  const response = await fetch(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${DART_KEY}`);
  if (!response.ok) throw new Error(`corpCode.xml HTTP ${response.status}`);
  const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
  const entry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith(".xml"));
  if (!entry) return null;
  const xml = entry.getData().toString("utf8");
  const re = /<list>([\s\S]*?)<\/list>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const item = m[1];
    const stock = (item.match(/<stock_code>(.*?)<\/stock_code>/)?.[1] || "").trim();
    if (stock === stockCode) return (item.match(/<corp_code>(.*?)<\/corp_code>/)?.[1] || "").trim();
  }
  return null;
}
function account(list, aliases, statements = []) {
  const rows = list.filter(row => {
    const accountName = (row.account_nm || "").replace(/\s/g, "");
    const sjName = row.sj_nm || "";
    const a = aliases.some(alias => accountName.includes(alias.replace(/\s/g, "")));
    const s = statements.length === 0 || statements.some(name => sjName.includes(name));
    return a && s;
  });
  if (!rows.length) return "-";
  return toNumber((rows.find(row => row.fs_nm?.includes("연결")) || rows[0]).thstrm_amount);
}
async function dartFinancial(corpCode, year, reportCode) {
  const data = await dartJson("fnlttSinglAcntAll.json", {
    corp_code: corpCode,
    bsns_year: String(year),
    reprt_code: reportCode,
    fs_div: "CFS"
  });
  const list = data.list || [];
  if (!list.length) return null;
  const revenue = account(list, ALIASES.revenue, ["손익계산서", "포괄손익계산서"]);
  const operatingProfit = account(list, ALIASES.operatingProfit, ["손익계산서", "포괄손익계산서"]);
  const netIncome = account(list, ALIASES.netIncome, ["손익계산서", "포괄손익계산서"]);
  const liabilities = account(list, ALIASES.liabilities, ["재무상태표"]);
  const equity = account(list, ALIASES.equity, ["재무상태표"]);
  const eps = account(list, ALIASES.eps, ["손익계산서", "포괄손익계산서"]);
  return {
    revenue,
    operatingProfit,
    netIncome,
    eps,
    operatingMargin: revenue !== "-" && operatingProfit !== "-" ? Number((operatingProfit / revenue * 100).toFixed(2)) : "-",
    netMargin: revenue !== "-" && netIncome !== "-" ? Number((netIncome / revenue * 100).toFixed(2)) : "-",
    debtRatio: liabilities !== "-" && equity !== "-" ? Number((liabilities / equity * 100).toFixed(2)) : "-",
    roe: netIncome !== "-" && equity !== "-" ? Number((netIncome / equity * 100).toFixed(2)) : "-"
  };
}
function table(columns, values) {
  const rows = [
    ["매출액", "revenue", true],
    ["영업이익", "operatingProfit", true],
    ["당기순이익", "netIncome", true],
    ["영업이익률", "operatingMargin", false],
    ["순이익률", "netMargin", false],
    ["ROE", "roe", false],
    ["부채비율", "debtRatio", false],
    ["EPS", "eps", false]
  ].map(([label, key, amount]) => ({
    label,
    values: values.map(v => amount ? formatWon(v?.[key]) : (v?.[key] ?? "-"))
  }));
  return { columns, rows };
}
async function financialSections(corpCode) {
  const y = new Date().getUTCFullYear();
  const annualColumns = [], annualValues = [];
  for (const year of [y - 3, y - 2, y - 1]) {
    try {
      const v = await dartFinancial(corpCode, year, "11011");
      if (v) { annualColumns.push(`${year}.12`); annualValues.push(v); }
      await sleep(250);
    } catch (e) { console.warn(`Annual skip ${corpCode} ${year}: ${e.message}`); }
  }
  const quarterColumns = [], quarterValues = [];
  for (const year of [y - 1, y]) {
    for (const r of REPORTS) {
      try {
        const v = await dartFinancial(corpCode, year, r.code);
        if (v) { quarterColumns.push(`${year}.${r.month}`); quarterValues.push(v); }
        await sleep(250);
      } catch (e) { console.warn(`Quarter skip ${corpCode} ${year} ${r.code}: ${e.message}`); }
    }
  }
  return {
    annual: table(annualColumns, annualValues),
    quarter: table(quarterColumns.slice(-6), quarterValues.slice(-6)),
    latest: [...quarterValues].reverse().find(Boolean) || [...annualValues].reverse().find(Boolean) || null
  };
}
async function buildStock(config, configsByCode, kiwoomTokenValue) {
  console.log(`Updating ${config.code} ${config.name}`);
  const naver = await fetchNaver(config.code).catch(e => {
    console.warn(`Naver skip ${config.code}: ${e.message}`);
    return { currentPrice: "-", changeRate: "-", metrics: {} };
  });
  const kiwoom = await fetchKiwoomQuoteRest(config.code, kiwoomTokenValue).catch(e => {
    console.warn(`Kiwoom skip ${config.code}: ${e.message}`);
    return null;
  });
  const corpCode = config.corpCode || await corpCodeFromDart(config.code).catch(() => null);
  let annual = { columns: [], rows: [] }, quarter = { columns: [], rows: [] }, latest = null;
  if (corpCode) {
    try {
      const dart = await financialSections(corpCode);
      annual = dart.annual; quarter = dart.quarter; latest = dart.latest;
    } catch (e) { console.warn(`DART skip ${config.code}: ${e.message}`); }
  }
  const peers = [];
  for (const peerCode of config.peers || []) {
    const peerConfig = configsByCode.get(peerCode);
    if (!peerConfig) continue;
    const peerNaver = await fetchNaver(peerCode).catch(() => ({ metrics: {} }));
    const peerKiwoom = await fetchKiwoomQuoteRest(peerCode, kiwoomTokenValue).catch(() => null);
    const peer = peerKiwoom || peerNaver;
    peers.push({
      code: peerCode,
      name: peerConfig.name || peerCode,
      marketCap: peer.metrics.marketCap || "-",
      per: peer.metrics.per || "-",
      pbr: peer.metrics.pbr || "-",
      roe: "-"
    });
    await sleep(200);
  }
  return {
    code: config.code,
    name: config.name,
    corpCode: corpCode || "",
    description: config.description || "",
    currentPrice: (kiwoom?.currentPrice ?? naver.currentPrice) || "-",
    changeRate: (kiwoom?.changeRate ?? naver.changeRate) || "-",
    targetPrice: "-",
    source: "Kiwoom + Naver + OpenDART",
    metrics: {
      per: (kiwoom?.metrics?.per ?? naver.metrics.per) || "-",
      pbr: (kiwoom?.metrics?.pbr ?? naver.metrics.pbr) || "-",
      roe: latest?.roe ?? "-",
      eps: latest?.eps ?? "-",
      bps: "-",
      marketCap: (kiwoom?.metrics?.marketCap ?? naver.metrics.marketCap) || "-",
      dividendYield: (kiwoom?.metrics?.dividendYield ?? naver.metrics.dividendYield) || "-",
      dividend: "-"
    },
    peers,
    annual,
    quarter
  };
}
async function main() {
  const config = JSON.parse(fs.readFileSync(STOCK_LIST_PATH, "utf8"));
  const list = config.stocks || [];
  const configsByCode = new Map(list.map(item => [item.code, item]));
  const kiwoomTokenValue = await kiwoomRestToken().catch((e) => {
    console.warn(`Kiwoom auth skip: ${e.message}`);
    return null;
  });
  const allStocks = await fetchKiwoomUniverseRest(kiwoomTokenValue).catch((e) => {
    console.warn(`Kiwoom universe skip: ${e.message}`);
    return [];
  });
  const stocks = [];
  for (const item of list) {
    stocks.push(await buildStock(item, configsByCode, kiwoomTokenValue));
    await sleep(500);
  }
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({
    updatedAt: new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false }),
    universeSource: allStocks.length ? "Kiwoom REST API (ka10099)" : "Config",
    allStocks: allStocks.length ? allStocks : list.map((item) => ({ code: item.code, name: item.name, market: "" })),
    stocks
  }, null, 2), "utf8");
  console.log(`Saved ${OUTPUT_PATH}`);
}
main().catch(error => { console.error(error); process.exit(1); });
