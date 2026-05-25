const state = {
  stocks: [],
  selected: null,
};

const formatValue = (value, suffix = "") => {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number") return value.toLocaleString("ko-KR") + suffix;
  return value + suffix;
};

async function loadStocks() {
  const response = await fetch(`./data/stocks.json?v=${Date.now()}`);
  if (!response.ok) {
    throw new Error("stocks.json을 불러오지 못했습니다.");
  }

  const data = await response.json();
  state.stocks = data.stocks || [];
  document.getElementById("updatedAt").textContent =
    `데이터 업데이트: ${data.updatedAt || "-"}`;

  fillStockSelect();
  selectStock(state.stocks[0]?.code, { preserveSearch: true });
}

function fillStockSelect() {
  const select = document.getElementById("stockSelect");
  select.innerHTML = "";

  state.stocks.forEach((stock) => {
    const option = document.createElement("option");
    option.value = stock.code;
    option.textContent = `${stock.name} (${stock.code})`;
    select.appendChild(option);
  });
}

function selectStock(code, options = {}) {
  const { preserveSearch = false } = options;
  const stock = state.stocks.find((item) => item.code === code);
  if (!stock) return;

  state.selected = stock;
  document.getElementById("stockSelect").value = stock.code;
  if (!preserveSearch) {
    document.getElementById("stockSearch").value = "";
  }

  renderSummary(stock);
  renderPeers(stock);
  renderFinancialTable("annualTable", stock.annual);
  renderFinancialTable("quarterTable", stock.quarter);
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
  const maxPer = Math.max(...peers.map((p) => p.per || 0), stock.metrics.per || 0, 1);
  const maxPbr = Math.max(...peers.map((p) => p.pbr || 0), stock.metrics.pbr || 0, 1);
  const maxRoe = Math.max(...peers.map((p) => p.roe || 0), stock.metrics.roe || 0, 1);

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
          <div class="bar-fill" style="--w:${Math.max(4, Math.min(100, value / max * 100))}%"></div>
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

document.getElementById("stockSelect").addEventListener("change", (event) => {
  selectStock(event.target.value);
});

let isComposing = false;
const stockSearch = document.getElementById("stockSearch");

stockSearch.addEventListener("compositionstart", () => {
  isComposing = true;
});

stockSearch.addEventListener("compositionend", () => {
  isComposing = false;
  stockSearch.dispatchEvent(new Event("input", { bubbles: true }));
});

stockSearch.addEventListener("input", (event) => {
  if (isComposing) return;
  const keyword = event.target.value.trim().toLowerCase();
  if (!keyword) return;

  const found = state.stocks.find((stock) =>
    stock.name.toLowerCase().includes(keyword) ||
    stock.code.includes(keyword)
  );

  if (found) selectStock(found.code, { preserveSearch: true });
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
