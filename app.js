const state = {
  stocks: [],
  universe: [],
  selected: null,
  filteredStocks: [],
  activeSuggestionIndex: -1,
};

const formatValue = (value, suffix = "") => {
  if (value === null || value === undefined || value === "") return "-";
  if (value === "-") return "-";
  if (typeof value === "number") return value.toLocaleString("ko-KR") + suffix;
  return value + suffix;
};

const chartNumber = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

async function loadStocks() {
  const response = await fetch(`./data/stocks.json?v=${Date.now()}`);
  if (!response.ok) {
    throw new Error("stocks.json을 불러오지 못했습니다.");
  }

  const data = await response.json();
  state.stocks = data.stocks || [];
  state.universe = data.allStocks || state.stocks.map((item) => ({ code: item.code, name: item.name, market: "" }));
  document.getElementById("updatedAt").textContent =
    `데이터 업데이트: ${data.updatedAt || "-"}`;

  selectStock(state.stocks[0]?.code || state.universe[0]?.code, { preserveSearch: true });
}

function normalizeKeyword(value) {
  return value.trim().toLowerCase();
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
    /^(1Q|ACE|ARIRANG|HANARO|KBSTAR|KIWOOM|KODEX|KOSEF|PLUS|RISE|SOL|TIMEFOLIO|TIGER)\b/.test(name);
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

function filterStocks(keyword) {
  const normalized = normalizeKeyword(keyword);
  state.filteredStocks = normalized
    ? state.universe
      .filter((stock) => {
        const name = stock.name.toLowerCase();
        const code = stock.code.toLowerCase();
        return name.includes(normalized) || code.includes(normalized) || stockLabel(stock).toLowerCase().includes(normalized);
      })
      .sort((a, b) => compareSearchResult(a, b, normalized))
    : [];
  state.activeSuggestionIndex = state.filteredStocks.length ? 0 : -1;
}

function findExactStock(keyword) {
  const normalized = normalizeKeyword(keyword);
  if (!normalized) return null;
  return state.universe.find((stock) =>
    stock.name.toLowerCase() === normalized ||
    stock.code.toLowerCase() === normalized ||
    stockLabel(stock).toLowerCase() === normalized
  ) || null;
}

function renderStockSuggestions() {
  const suggestions = document.getElementById("stockSuggestions");
  const input = document.getElementById("stockSearch");
  suggestions.innerHTML = "";

  if (!input.value.trim()) {
    hideStockSuggestions();
    return;
  }

  input.setAttribute("aria-expanded", "true");
  suggestions.hidden = false;

  if (!state.filteredStocks.length) {
    const empty = document.createElement("div");
    empty.className = "suggestion-empty";
    empty.textContent = "일치하는 종목이 없습니다.";
    suggestions.appendChild(empty);
    return;
  }

  state.filteredStocks.slice(0, 100).forEach((stock, index) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = `suggestion-item${index === state.activeSuggestionIndex ? " active" : ""}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", index === state.activeSuggestionIndex ? "true" : "false");
    option.dataset.code = stock.code;

    const main = document.createElement("span");
    main.className = "suggestion-main";

    const name = document.createElement("strong");
    name.textContent = stock.name;

    const market = document.createElement("small");
    market.textContent = stock.market || "시장 정보 없음";

    const code = document.createElement("span");
    code.className = "suggestion-code";
    code.textContent = stock.code;

    main.append(name, market);
    option.append(main, code);
    suggestions.appendChild(option);
  });
}

function hideStockSuggestions() {
  const suggestions = document.getElementById("stockSuggestions");
  const input = document.getElementById("stockSearch");
  suggestions.hidden = true;
  suggestions.innerHTML = "";
  input.setAttribute("aria-expanded", "false");
  state.activeSuggestionIndex = -1;
}

function chooseStock(code) {
  selectStock(code, { preserveSearch: true });
  if (state.selected) {
    document.getElementById("stockSearch").value = stockLabel(state.selected);
  }
  hideStockSuggestions();
}

function selectStock(code, options = {}) {
  const { preserveSearch = false } = options;
  const stock = state.stocks.find((item) => item.code === code);
  const basic = state.universe.find((item) => item.code === code);
  const marketText = basic?.market ? `${basic.market} 종목입니다.` : "전체 종목 목록에 포함된 종목입니다.";
  const selected = stock || {
    code: code || "-",
    name: basic?.name || code || "-",
    market: basic?.market || "",
    description: `${marketText} 저장된 상세 재무 데이터가 아직 없어 기본 정보만 표시합니다.`,
    currentPrice: "-",
    changeRate: "-",
    targetPrice: "-",
    metrics: { per: "-", pbr: "-", roe: "-", eps: "-", bps: "-", marketCap: "-", dividendYield: "-", dividend: "-" },
    peers: [],
    annual: { columns: [], rows: [] },
    quarter: { columns: [], rows: [] }
  };

  state.selected = selected;
  if (!preserveSearch) {
    document.getElementById("stockSearch").value = "";
  }

  renderSummary(selected);
  renderPeers(selected);
  renderFinancialTable("annualTable", selected.annual);
  renderFinancialTable("quarterTable", selected.quarter);
}

function renderSummary(stock) {
  document.getElementById("stockName").textContent = `${stock.name} (${stock.code})`;
  document.getElementById("stockDesc").textContent = stock.description || "";
  document.getElementById("currentPrice").textContent = formatValue(stock.currentPrice, "원");
  document.getElementById("changeRate").textContent = stock.changeRate && stock.changeRate !== "-" ? `${stock.changeRate}%` : "-";

  const metrics = [
    ["PER", stock.metrics.per, "배"],
    ["PBR", stock.metrics.pbr, "배"],
    ["ROE", stock.metrics.roe, "%"],
    ["EPS", stock.metrics.eps, "원"],
    ["BPS", stock.metrics.bps, "원"],
    ["시가총액", stock.metrics.marketCap, ""],
    ["배당수익률", stock.metrics.dividendYield, "%"],
    ["배당금", stock.metrics.dividend, "원"],
    ["목표가", stock.targetPrice, "원"],
  ];

  document.getElementById("metricGrid").innerHTML = metrics
    .map(([label, value, suffix]) => `
      <article class="metric">
        <span>${label}</span>
        <strong>${formatValue(value, suffix)}</strong>
      </article>
    `)
    .join("");
}

function renderPeers(stock) {
  const peers = stock.peers || [];
  const maxPer = Math.max(...peers.map((p) => chartNumber(p.per)), chartNumber(stock.metrics.per), 1);
  const maxPbr = Math.max(...peers.map((p) => chartNumber(p.pbr)), chartNumber(stock.metrics.pbr), 1);
  const maxRoe = Math.max(...peers.map((p) => chartNumber(p.roe)), chartNumber(stock.metrics.roe), 1);

  const bars = [
    ["PER", stock.metrics.per, maxPer, "배"],
    ["PBR", stock.metrics.pbr, maxPbr, "배"],
    ["ROE", stock.metrics.roe, maxRoe, "%"],
  ];

  document.getElementById("peerBars").innerHTML = bars
    .map(([label, value, max, suffix]) => `
      <div class="bar-item">
        <div class="bar-head">
          <strong>${label}</strong>
          <span>내 종목 ${formatValue(value, suffix)} / 비교 최대 ${formatValue(max, suffix)}</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill" style="--w:${Math.max(0, Math.min(100, chartNumber(value) / max * 100))}%"></div>
        </div>
      </div>
    `)
    .join("");

  const rows = peers.map((peer) => `
    <tr>
      <td>${peer.name}</td>
      <td>${formatValue(peer.marketCap)}</td>
      <td>${formatValue(peer.per, "배")}</td>
      <td>${formatValue(peer.pbr, "배")}</td>
      <td>${formatValue(peer.roe, "%")}</td>
    </tr>
  `).join("");

  document.getElementById("peerTable").innerHTML = `
    <thead>
      <tr>
        <th>비교 종목</th>
        <th>시가총액</th>
        <th>PER</th>
        <th>PBR</th>
        <th>ROE</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  `;
}

function renderFinancialTable(tableId, section) {
  const table = document.getElementById(tableId);
  if (!section || !section.columns || !section.rows) {
    table.innerHTML = "<tbody><tr><td>데이터 없음</td></tr></tbody>";
    return;
  }

  const header = `
    <thead>
      <tr>
        <th>항목</th>
        ${section.columns.map((col) => `<th>${col}</th>`).join("")}
      </tr>
    </thead>
  `;

  const body = `
    <tbody>
      ${section.rows.map((row) => `
        <tr>
          <td>${row.label}</td>
          ${row.values.map((value) => `<td>${formatValue(value)}</td>`).join("")}
        </tr>
      `).join("")}
    </tbody>
  `;

  table.innerHTML = header + body;
}

let isComposing = false;
const stockSearch = document.getElementById("stockSearch");
const stockSuggestions = document.getElementById("stockSuggestions");

stockSearch.addEventListener("compositionstart", () => {
  isComposing = true;
});

stockSearch.addEventListener("compositionend", () => {
  isComposing = false;
  stockSearch.dispatchEvent(new Event("input", { bubbles: true }));
});

stockSearch.addEventListener("input", (event) => {
  if (isComposing) return;
  const keyword = event.target.value;
  filterStocks(keyword);
  renderStockSuggestions();

  const exact = findExactStock(keyword);
  if (exact) selectStock(exact.code, { preserveSearch: true });
});

stockSearch.addEventListener("focus", () => {
  if (!stockSearch.value.trim()) return;
  filterStocks(stockSearch.value);
  renderStockSuggestions();
});

stockSearch.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" && state.filteredStocks.length) {
    event.preventDefault();
    state.activeSuggestionIndex = Math.min(state.activeSuggestionIndex + 1, Math.min(state.filteredStocks.length, 100) - 1);
    renderStockSuggestions();
    return;
  }

  if (event.key === "ArrowUp" && state.filteredStocks.length) {
    event.preventDefault();
    state.activeSuggestionIndex = Math.max(state.activeSuggestionIndex - 1, 0);
    renderStockSuggestions();
    return;
  }

  if (event.key === "Escape") {
    hideStockSuggestions();
    return;
  }

  if (event.key !== "Enter") return;
  event.preventDefault();
  const exact = findExactStock(stockSearch.value);
  const selected = exact || state.filteredStocks[state.activeSuggestionIndex] || state.filteredStocks[0];
  if (!selected) return;
  chooseStock(selected.code);
});

stockSuggestions.addEventListener("mousedown", (event) => {
  event.preventDefault();
  const option = event.target.closest(".suggestion-item");
  if (!option) return;
  chooseStock(option.dataset.code);
});

document.addEventListener("click", (event) => {
  if (event.target.closest(".search-combo")) return;
  hideStockSuggestions();
});

document.getElementById("refreshBtn").addEventListener("click", () => {
  loadStocks().catch((error) => alert(error.message));
});

document.querySelectorAll(".accordion").forEach((button) => {
  button.addEventListener("click", () => {
    const panel = button.closest(".panel");
    panel.classList.toggle("open");
    button.querySelector("span").textContent = panel.classList.contains("open") ? "닫기" : "열기";
  });
});

document.querySelectorAll(".panel").forEach((panel) => {
  panel.classList.add("open");
  const toggleLabel = panel.querySelector(".accordion span");
  if (toggleLabel) toggleLabel.textContent = "닫기";
});

loadStocks().catch((error) => {
  console.error(error);
  alert(error.message);
});
