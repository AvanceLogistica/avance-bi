/* ============================================================================
   AVANCE - PAINEL DE GESTÃO - LÓGICA DA APLICAÇÃO
   ============================================================================ */

const COLORS = {
  red: "#D0021B",
  redDark: "#8C0011",
  redSoft: "#F4A3AC",
  ink: "#17181C",
  inkSoft: "#8A8DA0",
  green: "#1C9A6C",
  amber: "#E1971F",
  grid: "#EDEDF1"
};

if (typeof Chart === "undefined") {
  document.getElementById("content").innerHTML =
    '<div class="empty-state"><div class="glyph">⚠️</div><h4>Não foi possível carregar a biblioteca de gráficos</h4>' +
    '<p>Confirme que o arquivo <code>chart.min.js</code> está na mesma pasta que <code>index.html</code>, ' +
    'e que os 4 arquivos (index.html, data.js, app.js, chart.min.js) não foram separados ao extrair/baixar.</p></div>';
  throw new Error("Chart.js não carregado - abortando inicialização do painel.");
}

Chart.defaults.font.family = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
Chart.defaults.color = "#5B5F6B";
Chart.defaults.font.size = 11.5;

if (typeof ChartDataLabels !== "undefined") {
  Chart.register(ChartDataLabels);
  Chart.defaults.set("plugins.datalabels", { display: false }); // desligado por padrão; ligo caso a caso abaixo
}
// Rótulo padrão para valores em R$ (compacto: 1.2K, 45K, 1.4M)
function fmtLabelBRL(v){
  if(v==null) return "";
  const abs = Math.abs(v);
  if(abs >= 1000000) return "R$ " + (v/1000000).toFixed(1).replace(".",",") + "M";
  if(abs >= 1000) return "R$ " + (v/1000).toFixed(1).replace(".",",") + "K";
  return "R$ " + Math.round(v);
}
function fmtLabelNum(v){ return v==null ? "" : fmtNum(Math.round(v)); }

/* ---------- Helpers de formatação ---------- */
function fmtBRL(v){
  if(v === null || v === undefined) return "—";
  return v.toLocaleString("pt-BR", {style:"currency", currency:"BRL", maximumFractionDigits:0});
}
function fmtBRL2(v){
  if(v === null || v === undefined) return "—";
  return v.toLocaleString("pt-BR", {style:"currency", currency:"BRL", maximumFractionDigits:2});
}
function fmtNum(v){
  if(v === null || v === undefined) return "—";
  return v.toLocaleString("pt-BR");
}
function fmtMil(v){
  return (v/1000).toLocaleString("pt-BR",{maximumFractionDigits:0}) + "K";
}
function sumArr(a){ return a.filter(v=>v!==null && v!==undefined).reduce((x,y)=>x+y,0); }
function deltaPct(a,b){ if(!b) return null; return ((a-b)/b*100); }

function deltaBadge(pct, invert){
  if(pct === null || isNaN(pct)) return `<span class="delta flat">— sem comparação</span>`;
  const up = pct >= 0;
  const good = invert ? !up : up;
  const cls = pct === 0 ? "flat" : (good ? "down" : "up");
  const arrow = pct === 0 ? "→" : (up ? "↑" : "↓");
  return `<span class="delta ${cls}">${arrow} ${Math.abs(pct).toFixed(1)}% vs. período anterior</span>`;
}

/* ---------- Navegação ---------- */
const pages = ["overview","entrada","manutencao","diesel","folha","horaextra","compras","atestados","infracoes","acidentes"];
const titles = {
  overview: ["Painel Executivo","Consolidado de indicadores · Avance Transporte Logístico"],
  entrada: ["Entrada de Dados","Lance valores por dia, semana ou mês — os gráficos atualizam na hora"],
  manutencao: ["Manutenção de Carreta","Custos de manutenção geral, pintura e outros serviços"],
  diesel: ["Diesel","Custo de abastecimento mensal, semanal e por veículo"],
  folha: ["Folha · Benefícios + Salário","Evolução de VT/VR, adicional 40% e salário"],
  horaextra: ["Hora Extra","Custo (R$) e quantidade (horas) por período e colaborador"],
  compras: ["Compras de Peças","Custo mensal, semanal e por local de aplicação"],
  atestados: ["Atestados","Ocorrências por período, colaborador e motivo"],
  infracoes: ["Infrações","Ocorrências, tipos, turnos e motoristas"],
  acidentes: ["Acidentes & Incidentes","Registro de ocorrências e plano de ação"]
};

const chartRegistry = {};
function destroyChart(id){ if(chartRegistry[id]){ chartRegistry[id].destroy(); delete chartRegistry[id]; } }
function mkChart(id, config){
  destroyChart(id);
  const el = document.getElementById(id);
  if(!el) return;
  try{
    chartRegistry[id] = new Chart(el.getContext("2d"), config);
  }catch(e){
    console.warn("Falha ao criar gráfico", id, e);
  }
}

function navigate(page){
  document.getElementById("pageTitle").textContent = titles[page][0];
  document.getElementById("pageSub").textContent = titles[page][1];
  document.querySelectorAll("nav.menu button").forEach(b=>{
    b.classList.toggle("active", b.dataset.page === page);
  });
  document.getElementById("content").innerHTML = renderers[page]();
  document.getElementById("sidebar").classList.remove("open");
  requestAnimationFrame(()=> initCharts[page] && initCharts[page]());
}

document.getElementById("navMenu").addEventListener("click", (e)=>{
  const btn = e.target.closest("button[data-page]");
  if(btn) navigate(btn.dataset.page);
});
document.getElementById("lastUpdate").textContent = DATA.meta.lastUpdate;

/* ============================================================================
   ENTRADA DE DADOS — funções de atualização e recálculo
   ============================================================================ */
const MONTH_ABBR = ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];

// Insere ou atualiza um período (mês/semana) em vários arrays paralelos de uma vez.
function upsertPeriod(container, labelsKey, label, valuesObj){
  const labels = container[labelsKey];
  let idx = labels.indexOf(label);
  if(idx === -1){ labels.push(label); idx = labels.length - 1; }
  Object.keys(valuesObj).forEach(k=>{
    if(!container[k]) container[k] = [];
    container[k][idx] = valuesObj[k];
  });
  return idx;
}
function sumIf(labels, values, test){
  let s = 0;
  labels.forEach((l,i)=>{ if(test(l) && values[i]!=null) s += values[i]; });
  return s;
}

function recomputeManutencao(){
  const m = DATA.manutencao;
  m.totalGeral = m.manutencaoGeral.map((v,i)=> (v||0)+(m.pinturaTeto[i]||0)+(m.outrosServicos[i]||0));
  m.totalPeriodo = sumArr(m.totalGeral);
  const totMG = sumArr(m.manutencaoGeral), totPT = sumArr(m.pinturaTeto), totOS = sumArr(m.outrosServicos);
  m.composicao = [
    { nome:"Manutenção Geral", valor:totMG, pct: m.totalPeriodo? Math.round(totMG/m.totalPeriodo*100):0 },
    { nome:"Pintura do Teto", valor:totPT, pct: m.totalPeriodo? Math.round(totPT/m.totalPeriodo*100):0 },
    { nome:"Outros Serviços", valor:totOS, pct: m.totalPeriodo? Math.round(totOS/m.totalPeriodo*100):0 }
  ];
}

function recomputeFolha(){
  const f = DATA.folha;
  // "Total de Salário" (linha do mês) = 40% Adicional + Salário (VT+VR é benefício e não entra nesse total)
  f.total = f.labels.map((_,i)=> (f.ad40[i]||0)+(f.salario[i]||0));
  // Os KPIs anuais (totalSalario2025_M / 2026_M) vêm de um fechamento à parte do RH — não são
  // a soma simples dos meses do gráfico, então só são atualizados se você digitar o valor novo
  // no formulário (campo "Total anual"), nunca recalculados sozinhos aqui.
}
function updateFolhaAnual(ano2025_M, ano2026_M){
  const f = DATA.folha;
  if(ano2025_M != null && !isNaN(ano2025_M)) f.totalSalario2025_M = ano2025_M;
  if(ano2026_M != null && !isNaN(ano2026_M)) f.totalSalario2026_M = ano2026_M;
  f.diferenca_M = +(f.totalSalario2026_M - f.totalSalario2025_M).toFixed(3);
  f.crescimentoPct = f.totalSalario2025_M ? Math.round((f.totalSalario2026_M-f.totalSalario2025_M)/f.totalSalario2025_M*100) : null;
}

function recomputeDiesel(){
  const d = DATA.diesel;
  d.totalAno2026 = Math.round(sumIf(d.mensalLabels, d.mensal, l=>l.includes("/26")));
  if(d.semanal_x1000.length) d.mediaSemanal = Math.round(d.semanal_x1000.reduce((a,b)=>a+b,0)/d.semanal_x1000.length*1000);
}

function recomputeHoraExtraCusto(){
  const he = DATA.horaExtraCusto;
  he.janJun2025 = Math.round(he.y2025.slice(0,6).reduce((a,b)=>a+(b||0),0));
  he.janJun2026 = Math.round(he.y2026.slice(0,6).reduce((a,b)=>a+(b||0),0));
  he.crescimentoPct = he.janJun2025 ? Math.round((he.janJun2026-he.janJun2025)/he.janJun2025*100) : null;
}
function recomputeHoraExtraQtd(){
  // "Total Jan-Mai 2026" e "% crescimento" desse card vêm do ranking Top 10 colaboradores,
  // não da série mensal completa — como a Entrada de Dados não edita o ranking linha a linha,
  // esses dois números não são recalculados aqui (evita sobrescrever com valor errado).
  // A série mensal (y2025/y2026) já reflete o novo lançamento assim que você adiciona.
}

function recomputeInfracoes(){
  const inf = DATA.infracoes;
  inf.totalAno2026 = Math.round(sumIf(inf.labels, inf.ocorrencias, l=>l.includes("/26")));
}

// Recalcula tudo do módulo Compras a partir dos lançamentos individuais (fonte única da verdade).
function deriveCompras(){
  const c = DATA.compras;
  const monthMap = {}, localMap = {}, catMap = {}, placaMap = {};
  c.comprasLancamentos.forEach(r=>{
    const ym = r.d.slice(0,7);
    monthMap[ym] = (monthMap[ym]||0) + r.v;
    if(r.l) localMap[r.l] = (localMap[r.l]||0) + r.v;
    const cat = r.c || "Sem categoria";
    catMap[cat] = (catMap[cat]||0) + r.v;
    if(r.p && r.p.trim()) placaMap[r.p.trim()] = (placaMap[r.p.trim()]||0) + r.v;
  });
  const keys = Object.keys(monthMap).sort();
  c.mensalLabels = keys.map(k=>{ const [y,mm] = k.split("-"); return MONTH_ABBR[parseInt(mm,10)-1] + "/" + y.slice(2); });
  c.mensal = keys.map(k=> Math.round(monthMap[k]));
  c.totalAno2026 = Math.round(keys.filter(k=>k.startsWith("2026")).reduce((s,k)=>s+monthMap[k],0));

  const totalGeral = Object.values(localMap).reduce((a,b)=>a+b,0);
  const locaisSorted = Object.entries(localMap).sort((a,b)=>b[1]-a[1]).slice(0,10);
  c.topLocais = locaisSorted.map(([local,valor])=>({ local, valor }));
  c.topLocaisTotal = Math.round(locaisSorted.reduce((s,[,v])=>s+v,0));

  c.porCategoria = Object.entries(catMap).sort((a,b)=>b[1]-a[1]).map(([categoria,valor])=>({ categoria, valor }));

  const placasSorted = Object.values(placaMap).sort((a,b)=>b-a);
  const top10Sum = placasSorted.slice(0,10).reduce((a,b)=>a+b,0);
  c.top10CaminhoesPct = totalGeral ? Math.round(top10Sum/totalGeral*100) : 0;
}

// Log de lançamentos feitos nesta sessão (só para feedback visual, não persiste sozinho)
const sessionLog = [];
function logEntry(modulo, descricao){
  sessionLog.unshift({ hora:new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}), modulo, descricao });
  if(sessionLog.length > 30) sessionLog.pop();
}
function toast(msg){
  const t = document.createElement("div");
  t.textContent = msg;
  t.style.cssText = "position:fixed; bottom:24px; right:24px; background:var(--ink); color:#fff; padding:12px 18px; border-radius:10px; font-size:13px; z-index:999; box-shadow:0 8px 24px rgba(0,0,0,.25); max-width:320px;";
  document.body.appendChild(t);
  setTimeout(()=>{ t.style.transition="opacity .4s"; t.style.opacity="0"; setTimeout(()=>t.remove(),400); }, 2600);
}

// Gera um novo data.js a partir do estado atual em memória e baixa o arquivo.
function exportDataJs(){
  const header = `/* ============================================================================\n   AVANCE - PAINEL DE GESTÃO - ARQUIVO DE DADOS\n   Exportado automaticamente pela tela "Entrada de Dados" em ${new Date().toLocaleString("pt-BR")}.\n   Substitua o data.js antigo por este arquivo (mantenha o mesmo nome: data.js).\n   ============================================================================ */\n\nconst DATA = `;
  const body = JSON.stringify(DATA, null, 2);
  const blob = new Blob([header + body + ";\n"], { type:"text/javascript" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "data.js";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* ============================================================================
   RENDERERS (HTML) por página
   ============================================================================ */
const renderers = {};
const initCharts = {};

/* -------------------- OVERVIEW -------------------- */
renderers.overview = () => {
  const m = DATA.manutencao, d = DATA.diesel, f = DATA.folha, he = DATA.horaExtraCusto,
        c = DATA.compras, at = DATA.atestados, inf = DATA.infracoes, ac = DATA.acidentes;

  const cards = [
    { page:"manutencao", ic:"🔩", label:"Manutenção de Carreta", big:fmtBRL(m.totalPeriodo), foot:"Total acumulado dez/25–jun/26", id:"spk-manutencao" },
    { page:"diesel", ic:"⛽", label:"Diesel (2026)", big:fmtBRL(d.totalAno2026), foot:"Média semanal " + fmtMil(d.mediaSemanal), id:"spk-diesel" },
    { page:"folha", ic:"💰", label:"Folha · Salário (2026)", big:f.totalSalario2026_M.toFixed(3).replace(".",",") + " Mi", foot:`+${f.crescimentoPct}% vs. 2025 (5 meses)`, id:"spk-folha" },
    { page:"horaextra", ic:"⏱️", label:"Hora Extra (jan–jun/26)", big:fmtBRL(he.janJun2026), foot:`+${he.crescimentoPct}% vs. mesmo período 2025`, id:"spk-he" },
    { page:"compras", ic:"🧰", label:"Compras de Peças (2026)", big:fmtBRL(c.totalAno2026), foot:`Top 10 veículos = ${c.top10CaminhoesPct}%`, id:"spk-compras" },
    { page:"atestados", ic:"🩺", label:"Atestados (mai/26)", big:fmtNum(at.ocorrencias[at.ocorrencias.length-1]), foot:"Ocorrências no último mês fechado", id:"spk-atestados" },
    { page:"infracoes", ic:"🚨", label:"Infrações (2026)", big:fmtNum(inf.totalAno2026), foot:`Uso de celular: ${inf.usoCelular2026} ocorrências`, id:"spk-infracoes" },
    { page:"acidentes", ic:"⚠️", label:"Acidentes & Incidentes", big:"0", foot:"Nenhuma ocorrência registrada em 2025", id:"spk-acidentes" }
  ];

  return `
    <div class="page-head">
      <h2>Bem-vindo, Fabiano 👋</h2>
      <p>Clique em qualquer indicador abaixo para abrir o módulo completo, com gráficos, tabelas e rankings.</p>
    </div>
    <div class="kpi-grid" style="grid-template-columns:repeat(auto-fit, minmax(230px,1fr));">
      ${cards.map(c=>`
        <div class="overview-card" onclick="navigate('${c.page}')">
          <div class="top">
            <div class="ic">${c.ic}</div>
            <div class="arrow">↗</div>
          </div>
          <h4>${c.label}</h4>
          <div class="big">${c.big}</div>
          <div class="foot">${c.foot}</div>
          <canvas id="${c.id}" height="36"></canvas>
        </div>
      `).join("")}
    </div>

    <div class="grid-2">
      <div class="panel">
        <h3>Custo de Hora Extra (R$) — 2025 vs 2026</h3>
        <div class="hint">Comparativo mensal, valores em reais</div>
        <div class="chart-wrap" style="height:260px;"><canvas id="ov-he"></canvas></div>
      </div>
      <div class="panel">
        <h3>Distribuição de Infrações por Tipo</h3>
        <div class="hint">Acumulado 2026</div>
        <div class="chart-wrap" style="height:260px;"><canvas id="ov-inf"></canvas></div>
      </div>
    </div>

    <div class="panel">
      <h3>Alertas de Gestão</h3>
      <div class="hint">Pontos que merecem atenção do diretor</div>
      <table>
        <thead><tr><th>Área</th><th>Indicador</th><th class="num">Situação</th></tr></thead>
        <tbody>
          <tr><td>Folha</td><td>Crescimento de salário 2025→2026</td><td class="num"><span class="badge red">+${f.crescimentoPct}%</span></td></tr>
          <tr><td>Hora Extra</td><td>Custo jan–jun 2026 vs 2025</td><td class="num"><span class="badge red">+${he.crescimentoPct}%</span></td></tr>
          <tr><td>Infrações</td><td>Não uso de cinto de segurança</td><td class="num"><span class="badge red">235 ocorrências</span></td></tr>
          <tr><td>Manutenção</td><td>Concentração em manutenção geral</td><td class="num"><span class="badge amber">96% do custo</span></td></tr>
          <tr><td>Acidentes</td><td>Registros formais em 2025</td><td class="num"><span class="badge green">0 ocorrências</span></td></tr>
        </tbody>
      </table>
    </div>
  `;
};

initCharts.overview = () => {
  const spark = (id, data, color) => mkChart(id, {
    type:"line",
    data:{ labels:data.map((_,i)=>i), datasets:[{ data, borderColor:color, borderWidth:2, pointRadius:0, tension:.35, fill:true, backgroundColor: color+"14" }]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}, tooltip:{enabled:false}},
      scales:{ x:{display:false}, y:{display:false} } }
  });
  spark("spk-manutencao", DATA.manutencao.totalGeral, COLORS.red);
  spark("spk-diesel", DATA.diesel.mensal, COLORS.red);
  spark("spk-folha", DATA.folha.total.filter(v=>v!==null), COLORS.red);
  spark("spk-he", DATA.horaExtraCusto.y2026.filter(v=>v!==null), COLORS.red);
  spark("spk-compras", DATA.compras.mensal, COLORS.red);
  spark("spk-atestados", DATA.atestados.ocorrencias, COLORS.red);
  spark("spk-infracoes", DATA.infracoes.ocorrencias, COLORS.red);
  spark("spk-acidentes", DATA.acidentes.valores, COLORS.green);

  const he = DATA.horaExtraCusto;
  mkChart("ov-he", {
    type:"bar",
    data:{ labels:he.labels, datasets:[
      { label:"2025", data:he.y2025, backgroundColor:"#D8D9E0", borderRadius:4 },
      { label:"2026", data:he.y2026, backgroundColor:COLORS.red, borderRadius:4 }
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{legend:{position:"bottom", labels:{boxWidth:10, usePointStyle:true, pointStyle:"circle"}}},
      scales:{ y:{grid:{color:COLORS.grid}, ticks:{callback:v=>fmtMil(v)}}, x:{grid:{display:false}} } }
  });

  const inf = DATA.infracoes;
  mkChart("ov-inf", {
    type:"doughnut",
    data:{ labels:inf.porTipo.map(t=>t.tipo), datasets:[{ data:inf.porTipo.map(t=>t.valor),
      backgroundColor:[COLORS.red, COLORS.ink, "#E58A93", COLORS.amber, "#B9BCC6", COLORS.green], borderWidth:2, borderColor:"#fff" }]},
    options:{ responsive:true, maintainAspectRatio:false, cutout:"62%",
      plugins:{legend:{position:"bottom", labels:{boxWidth:10, font:{size:10.5}, usePointStyle:true, pointStyle:"circle"}}} }
  });
};

/* -------------------- MANUTENÇÃO DE CARRETA -------------------- */
renderers.manutencao = () => {
  const m = DATA.manutencao;
  const ultimo = m.totalGeral[m.totalGeral.length-1];
  const penult = m.totalGeral[m.totalGeral.length-2];
  return `
    <div class="page-head"><h2>Manutenção de Carreta</h2><p>Custo em R$ por tipo de serviço, dez/25 a jun/26</p></div>
    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Total do período</div><div class="val">${fmtBRL(m.totalPeriodo)}</div></div>
      <div class="kpi"><div class="lbl">Manutenção geral</div><div class="val">${m.composicao[0].pct}%</div>${deltaBadge(0)}</div>
      <div class="kpi"><div class="lbl">Pintura do teto</div><div class="val">${m.composicao[1].pct}%</div></div>
      <div class="kpi"><div class="lbl">Último mês (${m.labels[m.labels.length-1]})</div><div class="val">${fmtBRL(ultimo)}</div>${deltaBadge(deltaPct(ultimo,penult), true)}</div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <h3>Custo mensal por serviço</h3>
        <div class="hint">Empilhado — Manutenção Geral, Pintura do Teto e Outros Serviços</div>
        <div class="chart-wrap" style="height:300px;"><canvas id="ch-manut-mensal"></canvas></div>
      </div>
      <div class="panel">
        <h3>Composição do custo total</h3>
        <div class="hint">% sobre o total do período</div>
        <div class="chart-wrap" style="height:300px;"><canvas id="ch-manut-comp"></canvas></div>
      </div>
    </div>
    <div class="panel">
      <h3>Detalhamento mensal</h3>
      <table>
        <thead><tr><th>Serviço</th>${m.labels.map(l=>`<th class="num">${l}</th>`).join("")}<th class="num">Total</th></tr></thead>
        <tbody>
          <tr><td>Manutenção Geral</td>${m.manutencaoGeral.map(v=>`<td class="num">${fmtBRL(v)}</td>`).join("")}<td class="num"><b>${fmtBRL(m.composicao[0].valor)}</b></td></tr>
          <tr><td>Pintura do Teto</td>${m.pinturaTeto.map(v=>`<td class="num">${fmtBRL(v)}</td>`).join("")}<td class="num"><b>${fmtBRL(m.composicao[1].valor)}</b></td></tr>
          <tr><td>Outros Serviços</td>${m.outrosServicos.map(v=>`<td class="num">${fmtBRL(v)}</td>`).join("")}<td class="num"><b>${fmtBRL(m.composicao[2].valor)}</b></td></tr>
          <tr style="font-weight:700; background:var(--paper);"><td>Total Geral</td>${m.totalGeral.map(v=>`<td class="num">${fmtBRL(v)}</td>`).join("")}<td class="num">${fmtBRL(m.totalPeriodo)}</td></tr>
        </tbody>
      </table>
    </div>
  `;
};
initCharts.manutencao = () => {
  const m = DATA.manutencao;
  mkChart("ch-manut-mensal", {
    type:"bar",
    data:{ labels:m.labels, datasets:[
      { label:"Manutenção Geral", data:m.manutencaoGeral, backgroundColor:COLORS.red, stack:"a", borderRadius:3 },
      { label:"Pintura do Teto", data:m.pinturaTeto, backgroundColor:COLORS.ink, stack:"a", borderRadius:3 },
      { label:"Outros", data:m.outrosServicos, backgroundColor:COLORS.amber, stack:"a", borderRadius:3 }
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{legend:{position:"bottom", labels:{boxWidth:10, usePointStyle:true, pointStyle:"circle"}},
        datalabels:{ display:(ctx)=>ctx.dataset.data[ctx.dataIndex] > 8000, color:"#fff", font:{size:9, weight:700}, formatter:fmtLabelBRL } },
      scales:{ x:{stacked:true, grid:{display:false}}, y:{stacked:true, grid:{color:COLORS.grid}, ticks:{callback:v=>fmtMil(v)}} } }
  });
  const totalComp = sumArr(m.composicao.map(c=>c.valor));
  mkChart("ch-manut-comp", {
    type:"doughnut",
    data:{ labels:m.composicao.map(c=>c.nome), datasets:[{ data:m.composicao.map(c=>c.valor), backgroundColor:[COLORS.red, COLORS.ink, COLORS.amber], borderWidth:2, borderColor:"#fff" }]},
    options:{ responsive:true, maintainAspectRatio:false, cutout:"62%",
      plugins:{legend:{position:"bottom", labels:{usePointStyle:true, pointStyle:"circle"}},
        datalabels:{ display:(ctx)=>ctx.dataset.data[ctx.dataIndex]/totalComp > 0.02, color:"#fff", font:{size:11, weight:700},
          formatter:(v)=> totalComp? Math.round(v/totalComp*100)+"%" : "" } } }
  });
};

/* -------------------- DIESEL -------------------- */
renderers.diesel = () => {
  const d = DATA.diesel;
  return `
    <div class="page-head"><h2>Diesel</h2><p>Custo de abastecimento — jul/25 a jun/26</p></div>
    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Total 2026</div><div class="val">${fmtBRL(d.totalAno2026)}</div></div>
      <div class="kpi"><div class="lbl">Média semanal</div><div class="val">${fmtMil(d.mediaSemanal)}</div></div>
      <div class="kpi"><div class="lbl">Top 10 caminhões</div><div class="val">${d.topCaminhoesTotalPct}%</div><div class="delta flat">do custo total 2026</div></div>
      <div class="kpi"><div class="lbl">Maior mês</div><div class="val">${fmtBRL(Math.max(...d.mensal))}</div><div class="delta flat">mar/26</div></div>
    </div>
    <div class="panel" style="margin-bottom:16px;">
      <h3>Custo mensal (jul/25–jun/26)</h3>
      <div class="chart-wrap" style="height:280px;"><canvas id="ch-diesel-mensal"></canvas></div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <h3>Custo semanal 2026 (R$ mil)</h3>
        <div class="chart-wrap" style="height:260px;"><canvas id="ch-diesel-semanal"></canvas></div>
      </div>
      <div class="panel">
        <h3>10 maiores caminhões (2026)</h3>
        <div class="hint">Representam ${d.topCaminhoesTotalPct}% do custo total</div>
        <table>
          <thead><tr><th>#</th><th>Placa</th><th class="num">Valor</th><th class="num">%</th></tr></thead>
          <tbody>
            ${d.topCaminhoes.map((t,i)=>`<tr><td class="rank">${i+1}</td><td>${t.placa}</td><td class="num">${fmtBRL2(t.valor)}</td><td class="num">${t.pct.toFixed(2)}%</td></tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
};
initCharts.diesel = () => {
  const d = DATA.diesel;
  mkChart("ch-diesel-mensal", {
    type:"bar",
    data:{ labels:d.mensalLabels, datasets:[{ data:d.mensal, backgroundColor:d.mensal.map(v=>v===Math.max(...d.mensal)?COLORS.redDark:COLORS.red), borderRadius:5 }]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
        datalabels:{ display:true, anchor:"end", align:"top", offset:2, color:COLORS.ink, font:{size:10, weight:700}, formatter:fmtLabelBRL } },
      layout:{ padding:{ top:18 } },
      scales:{ y:{grid:{color:COLORS.grid}, ticks:{callback:v=>fmtMil(v)}}, x:{grid:{display:false}} } }
  });
  mkChart("ch-diesel-semanal", {
    type:"line",
    data:{ labels:d.semanalLabels, datasets:[{ data:d.semanal_x1000, borderColor:COLORS.red, backgroundColor:COLORS.red+"1A", fill:true, tension:.3, pointRadius:2 }]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}},
      scales:{ y:{grid:{color:COLORS.grid}, ticks:{callback:v=>v+"K"}}, x:{grid:{display:false}, ticks:{maxRotation:0, autoSkip:true, maxTicksLimit:12}} } }
  });
};

/* -------------------- FOLHA -------------------- */
renderers.folha = () => {
  const f = DATA.folha;
  return `
    <div class="page-head"><h2>Folha · Benefícios + Salário</h2><p>VT/VR, adicional 40% e salário — jan/25 a mai/26</p></div>
    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Total Salário 2025</div><div class="val">${f.totalSalario2025_M.toFixed(3).replace(".",",")} Mi</div></div>
      <div class="kpi"><div class="lbl">Total Salário 2026 (5 meses)</div><div class="val">${f.totalSalario2026_M.toFixed(3).replace(".",",")} Mi</div></div>
      <div class="kpi"><div class="lbl">Diferença</div><div class="val">${f.diferenca_M.toFixed(3).replace(".",",")} Mi</div></div>
      <div class="kpi"><div class="lbl">Crescimento</div><div class="val">${f.crescimentoPct}%</div><span class="delta up">↑ 2025 → 2026</span></div>
    </div>
    <div class="panel">
      <h3>Composição mensal do custo (R$ mil)</h3>
      <div class="hint">VT+VR, 40% adicional e salário — linha preta: total</div>
      <div class="chart-wrap" style="height:320px;"><canvas id="ch-folha"></canvas></div>
      <p class="legend-note">* jun/26 ainda não fechado na data de atualização deste painel.</p>
    </div>
  `;
};
initCharts.folha = () => {
  const f = DATA.folha;
  mkChart("ch-folha", {
    data:{ labels:f.labels, datasets:[
      { type:"bar", label:"VT+VR", data:f.vtVr, backgroundColor:"#F0B9C0", stack:"a", borderRadius:2, datalabels:{display:false} },
      { type:"bar", label:"40% Adicional", data:f.ad40, backgroundColor:COLORS.red, stack:"a", borderRadius:2, datalabels:{display:false} },
      { type:"bar", label:"Salário", data:f.salario, backgroundColor:COLORS.ink, stack:"a", borderRadius:2, datalabels:{display:false} },
      { type:"line", label:"Total", data:f.total, borderColor:"#000", borderWidth:2, pointRadius:2, tension:.25,
        datalabels:{ display:(ctx)=>ctx.dataset.data[ctx.dataIndex]!=null, align:"top", offset:6, color:COLORS.ink, font:{size:9, weight:700}, formatter:fmtLabelBRL } }
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{legend:{position:"bottom", labels:{boxWidth:10, usePointStyle:true, pointStyle:"circle"}}},
      layout:{ padding:{ top:16 } },
      scales:{ x:{stacked:true, grid:{display:false}, ticks:{maxRotation:60, minRotation:60}}, y:{stacked:true, grid:{color:COLORS.grid}} } }
  });
};

/* -------------------- HORA EXTRA -------------------- */
renderers.horaextra = () => {
  const he = DATA.horaExtraCusto, hq = DATA.horaExtraQtd;
  return `
    <div class="page-head"><h2>Hora Extra</h2><p>Custo (R$) e quantidade (horas), 2025 vs 2026</p></div>
    <div class="tabs">
      <button class="tab-btn active" data-tab="custo">Custo (R$)</button>
      <button class="tab-btn" data-tab="qtd">Quantidade (Horas)</button>
    </div>

    <div class="subtab active" id="tab-custo">
      <div class="kpi-grid">
        <div class="kpi"><div class="lbl">Jan–Jun 2025</div><div class="val">${fmtBRL(he.janJun2025)}</div></div>
        <div class="kpi"><div class="lbl">Jan–Jun 2026</div><div class="val">${fmtBRL(he.janJun2026)}</div></div>
        <div class="kpi"><div class="lbl">Variação</div><div class="val">+${he.crescimentoPct}%</div><span class="delta up">↑ período a período</span></div>
        <div class="kpi"><div class="lbl">Top 10 colaboradores</div><div class="val">${fmtBRL(he.top10TotalGeral)}</div><div class="delta flat">${he.top10Pct}% do total</div></div>
      </div>
      <div class="panel" style="margin-bottom:16px;">
        <h3>Custo mensal — 2025 vs 2026</h3>
        <div class="chart-wrap" style="height:280px;"><canvas id="ch-he-custo"></canvas></div>
      </div>
      <div class="panel">
        <h3>10 maiores em 2026 (R$)</h3>
        <table>
          <thead><tr><th>#</th><th>Colaborador</th><th class="num">Jan</th><th class="num">Fev</th><th class="num">Mar</th><th class="num">Abr</th><th class="num">Mai</th><th class="num">Jun</th><th class="num">Total</th></tr></thead>
          <tbody>
            ${he.top10.map((t,i)=>`<tr><td class="rank">${i+1}</td><td>${t.nome}</td><td class="num">${fmtBRL2(t.jan)}</td><td class="num">${fmtBRL2(t.fev)}</td><td class="num">${fmtBRL2(t.mar)}</td><td class="num">${fmtBRL2(t.abr)}</td><td class="num">${fmtBRL2(t.mai)}</td><td class="num">${fmtBRL2(t.jun)}</td><td class="num"><b>${fmtBRL2(t.total)}</b></td></tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>

    <div class="subtab" id="tab-qtd">
      <div class="kpi-grid">
        <div class="kpi"><div class="lbl">Total horas (jan–jun/26)</div><div class="val">${fmtNum(hq.totalJanMai2026)} h</div></div>
        <div class="kpi"><div class="lbl">Variação mensal</div><div class="val">+${hq.crescimentoPct}%</div></div>
        <div class="kpi"><div class="lbl">Maior colaborador</div><div class="val">${hq.top10[0].total} h</div><div class="delta flat">${hq.top10[0].nome}</div></div>
        <div class="kpi"><div class="lbl">Média mensal top 10</div><div class="val">${Math.round(hq.top10.reduce((a,t)=>a+t.total,0)/10/6)} h</div></div>
      </div>
      <div class="panel" style="margin-bottom:16px;">
        <h3>Quantidade de horas extras — 2025 vs 2026</h3>
        <div class="chart-wrap" style="height:280px;"><canvas id="ch-he-qtd"></canvas></div>
      </div>
      <div class="panel">
        <h3>10 maiores em 2026 (horas)</h3>
        <table>
          <thead><tr><th>#</th><th>Colaborador</th><th class="num">Jan</th><th class="num">Fev</th><th class="num">Mar</th><th class="num">Abr</th><th class="num">Mai</th><th class="num">Jun</th><th class="num">Total</th></tr></thead>
          <tbody>
            ${hq.top10.map((t,i)=>`<tr><td class="rank">${i+1}</td><td>${t.nome}</td><td class="num">${t.jan}</td><td class="num">${t.fev}</td><td class="num">${t.mar}</td><td class="num">${t.abr}</td><td class="num">${t.mai}</td><td class="num">${t.jun}</td><td class="num"><b>${t.total}</b></td></tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
};
initCharts.horaextra = () => {
  const he = DATA.horaExtraCusto, hq = DATA.horaExtraQtd;

  document.querySelectorAll(".tab-btn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      document.querySelectorAll(".tab-btn").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".subtab").forEach(s=>s.classList.remove("active"));
      document.getElementById("tab-"+btn.dataset.tab).classList.add("active");
    });
  });

  mkChart("ch-he-custo", {
    type:"bar",
    data:{ labels:he.labels, datasets:[
      { label:"2025", data:he.y2025, backgroundColor:"#D8D9E0", borderRadius:4 },
      { label:"2026", data:he.y2026, backgroundColor:COLORS.red, borderRadius:4 }
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{legend:{position:"bottom", labels:{boxWidth:10, usePointStyle:true, pointStyle:"circle"}},
        datalabels:{ display:(ctx)=>ctx.dataset.data[ctx.dataIndex]!=null, anchor:"end", align:"top", offset:1, color:COLORS.ink, font:{size:8, weight:700}, formatter:fmtLabelBRL } },
      layout:{ padding:{ top:14 } },
      scales:{ y:{grid:{color:COLORS.grid}, ticks:{callback:v=>fmtMil(v)}}, x:{grid:{display:false}} } }
  });
  mkChart("ch-he-qtd", {
    type:"bar",
    data:{ labels:hq.labels, datasets:[
      { label:"2025", data:hq.y2025, backgroundColor:"#D8D9E0", borderRadius:4 },
      { label:"2026", data:hq.y2026, backgroundColor:COLORS.ink, borderRadius:4 }
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{legend:{position:"bottom", labels:{boxWidth:10, usePointStyle:true, pointStyle:"circle"}},
        datalabels:{ display:(ctx)=>ctx.dataset.data[ctx.dataIndex]!=null, anchor:"end", align:"top", offset:1, color:COLORS.ink, font:{size:8, weight:700}, formatter:fmtLabelNum } },
      layout:{ padding:{ top:14 } },
      scales:{ y:{grid:{color:COLORS.grid}}, x:{grid:{display:false}} } }
  });
};

/* -------------------- COMPRAS DE PEÇAS -------------------- */
renderers.compras = () => {
  const c = DATA.compras;
  const recentes = [...c.comprasLancamentos].sort((a,b)=> b.d.localeCompare(a.d)).slice(0,12);
  return `
    <div class="page-head"><h2>Compras de Peças</h2><p>Custo mensal, por categoria e por local — calculado a partir de ${fmtNum(c.comprasLancamentos.length)} lançamentos individuais</p></div>
    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Total 2026</div><div class="val">${fmtBRL(c.totalAno2026)}</div></div>
      <div class="kpi"><div class="lbl">Top 10 veículos</div><div class="val">${c.top10CaminhoesPct}%</div><div class="delta flat">do custo total</div></div>
      <div class="kpi"><div class="lbl">Maior mês</div><div class="val">${fmtBRL(Math.max(...c.mensal))}</div><div class="delta flat">${c.mensalLabels[c.mensal.indexOf(Math.max(...c.mensal))]}</div></div>
      <div class="kpi"><div class="lbl">Top 10 locais</div><div class="val">${fmtBRL(c.topLocaisTotal)}</div></div>
    </div>
    <div class="panel" style="margin-bottom:16px;">
      <h3>Custo mensal (R$)</h3>
      <div class="chart-wrap" style="height:280px;"><canvas id="ch-compras-mensal"></canvas></div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <h3>Custo por categoria</h3>
        <div class="hint">Total acumulado de todos os lançamentos</div>
        <div class="chart-wrap" style="height:260px;"><canvas id="ch-compras-cat"></canvas></div>
      </div>
      <div class="panel">
        <h3>10 maiores locais</h3>
        <table>
          <thead><tr><th>#</th><th>Local</th><th class="num">Valor</th></tr></thead>
          <tbody>
            ${c.topLocais.map((t,i)=>`<tr><td class="rank">${i+1}</td><td>${t.local}</td><td class="num">${fmtBRL2(t.valor)}</td></tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>
    <div class="panel">
      <h3>Lançamentos mais recentes</h3>
      <div class="hint">Últimos 12 registros — adicione novos em "Entrada de Dados"</div>
      <table>
        <thead><tr><th>Data</th><th>Placa</th><th>Local</th><th>Categoria</th><th>Item</th><th class="num">Valor</th></tr></thead>
        <tbody>
          ${recentes.map(r=>`<tr><td>${r.d.split('-').reverse().join('/')}</td><td>${r.p||"—"}</td><td>${r.l}</td><td>${r.c}</td><td>${r.i}</td><td class="num">${fmtBRL2(r.v)}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;
};
initCharts.compras = () => {
  const c = DATA.compras;
  mkChart("ch-compras-mensal", {
    type:"bar",
    data:{ labels:c.mensalLabels, datasets:[{ data:c.mensal, backgroundColor:COLORS.ink, borderRadius:5 }]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
        datalabels:{ display:true, anchor:"end", align:"top", offset:2, color:COLORS.ink, font:{size:10, weight:700}, formatter:fmtLabelBRL } },
      layout:{ padding:{ top:18 } },
      scales:{ y:{grid:{color:COLORS.grid}, ticks:{callback:v=>fmtMil(v)}}, x:{grid:{display:false}} } }
  });
  const catTop = c.porCategoria.slice(0,8);
  mkChart("ch-compras-cat", {
    type:"bar",
    data:{ labels:catTop.map(t=>t.categoria), datasets:[{ data:catTop.map(t=>t.valor), backgroundColor:COLORS.red, borderRadius:4 }]},
    options:{ indexAxis:"y", responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
        datalabels:{ display:true, anchor:"end", align:"right", color:COLORS.ink, font:{size:10, weight:700}, formatter:fmtLabelBRL } },
      layout:{ padding:{ right:46 } },
      scales:{ x:{grid:{color:COLORS.grid}, ticks:{callback:v=>fmtMil(v)}}, y:{grid:{display:false}} } }
  });
};

/* -------------------- ATESTADOS -------------------- */
renderers.atestados = () => {
  const at = DATA.atestados;
  return `
    <div class="page-head"><h2>Atestados</h2><p>Ocorrências por período, colaborador e motivo — jan/25 a mai/26</p></div>
    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Total do período</div><div class="val">${fmtNum(sumArr(at.ocorrencias))}</div></div>
      <div class="kpi"><div class="lbl">Último mês (mai/26)</div><div class="val">${at.ocorrencias[at.ocorrencias.length-1]}</div></div>
      <div class="kpi"><div class="lbl">Maior motivo</div><div class="val">${at.topMotivos[0].total}</div><div class="delta flat">${at.topMotivos[0].motivo}</div></div>
      <div class="kpi"><div class="lbl">Colaborador c/ mais ocorrências</div><div class="val">${at.topColaboradores[0].total}</div><div class="delta flat">${at.topColaboradores[0].nome}</div></div>
    </div>
    <div class="panel" style="margin-bottom:16px;">
      <h3>Ocorrências por mês</h3>
      <div class="chart-wrap" style="height:260px;"><canvas id="ch-atest-mensal"></canvas></div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <h3>10 colaboradores com mais ocorrências</h3>
        <table>
          <thead><tr><th>#</th><th>Colaborador</th><th class="num">2025</th><th class="num">2026</th><th class="num">Total</th></tr></thead>
          <tbody>${at.topColaboradores.map((t,i)=>`<tr><td class="rank">${i+1}</td><td>${t.nome}</td><td class="num">${t.y2025}</td><td class="num">${t.y2026}</td><td class="num"><b>${t.total}</b></td></tr>`).join("")}</tbody>
        </table>
      </div>
      <div class="panel">
        <h3>10 maiores motivos</h3>
        <table>
          <thead><tr><th>#</th><th>Motivo</th><th class="num">2025</th><th class="num">2026</th><th class="num">Total</th></tr></thead>
          <tbody>${at.topMotivos.map((t,i)=>`<tr><td class="rank">${i+1}</td><td>${t.motivo}</td><td class="num">${t.y2025}</td><td class="num">${t.y2026}</td><td class="num"><b>${t.total}</b></td></tr>`).join("")}</tbody>
        </table>
      </div>
    </div>
  `;
};
initCharts.atestados = () => {
  const at = DATA.atestados;
  mkChart("ch-atest-mensal", {
    type:"line",
    data:{ labels:at.labels, datasets:[{ data:at.ocorrencias, borderColor:COLORS.red, backgroundColor:COLORS.red+"1A", fill:true, tension:.3, pointRadius:3, pointBackgroundColor:COLORS.red }]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
        datalabels:{ display:true, align:"top", offset:6, color:COLORS.ink, font:{size:10, weight:700}, formatter:fmtLabelNum } },
      layout:{ padding:{ top:16 } },
      scales:{ y:{grid:{color:COLORS.grid}}, x:{grid:{display:false}, ticks:{maxRotation:60, minRotation:60}} } }
  });
};

/* -------------------- INFRAÇÕES -------------------- */
renderers.infracoes = () => {
  const inf = DATA.infracoes;
  return `
    <div class="page-head"><h2>Infrações</h2><p>Ocorrências, tipos, turnos e motoristas — nov/25 a jun/26</p></div>
    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Total 2026</div><div class="val">${fmtNum(inf.totalAno2026)}</div></div>
      <div class="kpi"><div class="lbl">Uso de celular</div><div class="val">${inf.usoCelular2026}</div><div class="delta up">ocorrências em 2026</div></div>
      <div class="kpi"><div class="lbl">1º Turno</div><div class="val">${inf.porTurno.turno1}</div><div class="delta flat">${((inf.porTurno.turno1/(inf.porTurno.turno1+inf.porTurno.turno2))*100).toFixed(0)}% do total</div></div>
      <div class="kpi"><div class="lbl">2º Turno</div><div class="val">${inf.porTurno.turno2}</div></div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <h3>Ocorrências mensais</h3>
        <div class="chart-wrap" style="height:260px;"><canvas id="ch-inf-mensal"></canvas></div>
      </div>
      <div class="panel">
        <h3>Por tipo de infração</h3>
        <div class="chart-wrap" style="height:260px;"><canvas id="ch-inf-tipo"></canvas></div>
      </div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <h3>10 motoristas com mais infrações (2026)</h3>
        <table>
          <thead><tr><th>#</th><th>Motorista</th><th class="num">Total</th></tr></thead>
          <tbody>${inf.topMotoristas.map((t,i)=>`<tr><td class="rank">${i+1}</td><td>${t.nome}</td><td class="num"><b>${t.total}</b></td></tr>`).join("")}</tbody>
        </table>
      </div>
      <div class="panel">
        <h3>10 placas com mais infrações (2026)</h3>
        <table>
          <thead><tr><th>#</th><th>Placa</th><th class="num">Total</th></tr></thead>
          <tbody>${inf.topPlacas.map((t,i)=>`<tr><td class="rank">${i+1}</td><td>${t.placa}</td><td class="num"><b>${t.total}</b></td></tr>`).join("")}</tbody>
        </table>
      </div>
    </div>
    <div class="panel">
      <h3>Ocorrências diárias — últimos registros</h3>
      <div class="hint">Detalhe complementar por turno (não soma automaticamente no total mensal)</div>
      <div class="chart-wrap" style="height:220px;"><canvas id="ch-inf-junho"></canvas></div>
    </div>
  `;
};
initCharts.infracoes = () => {
  const inf = DATA.infracoes;
  mkChart("ch-inf-mensal", {
    type:"line",
    data:{ labels:inf.labels, datasets:[{ data:inf.ocorrencias, borderColor:COLORS.red, backgroundColor:COLORS.red+"1A", fill:true, tension:.3, pointRadius:3, pointBackgroundColor:COLORS.red }]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
        datalabels:{ display:true, align:"top", offset:6, color:COLORS.ink, font:{size:10, weight:700}, formatter:fmtLabelNum } },
      layout:{ padding:{ top:16 } },
      scales:{ y:{grid:{color:COLORS.grid}}, x:{grid:{display:false}} } }
  });
  const totalTipo = sumArr(inf.porTipo.map(t=>t.valor));
  mkChart("ch-inf-tipo", {
    type:"doughnut",
    data:{ labels:inf.porTipo.map(t=>t.tipo), datasets:[{ data:inf.porTipo.map(t=>t.valor),
      backgroundColor:[COLORS.red, COLORS.ink, "#B9BCC6", COLORS.amber, "#E58A93", COLORS.green], borderWidth:2, borderColor:"#fff" }]},
    options:{ responsive:true, maintainAspectRatio:false, cutout:"60%",
      plugins:{legend:{position:"bottom", labels:{boxWidth:10, font:{size:10}, usePointStyle:true, pointStyle:"circle"}},
        datalabels:{ display:(ctx)=>ctx.dataset.data[ctx.dataIndex]/totalTipo > 0.02, color:"#fff", font:{size:10, weight:700},
          formatter:(v)=> totalTipo? Math.round(v/totalTipo*100)+"%" : "" } } }
  });
  mkChart("ch-inf-junho", {
    type:"bar",
    data:{ labels:inf.diario.labels.slice(-14), datasets:[
      { label:"1º Turno", data:inf.diario.turno1.slice(-14), backgroundColor:COLORS.red, stack:"a", borderRadius:3 },
      { label:"2º Turno", data:inf.diario.turno2.slice(-14), backgroundColor:COLORS.amber, stack:"a", borderRadius:3 }
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{legend:{position:"bottom", labels:{boxWidth:10, usePointStyle:true, pointStyle:"circle"}},
        datalabels:{ display:(ctx)=>ctx.dataset.data[ctx.dataIndex] > 0, color:"#fff", font:{size:9, weight:700}, formatter:fmtLabelNum } },
      scales:{ x:{stacked:true, grid:{display:false}}, y:{stacked:true, grid:{color:COLORS.grid}} } }
  });
};

/* -------------------- ACIDENTES -------------------- */
renderers.acidentes = () => {
  const ac = DATA.acidentes;
  return `
    <div class="page-head"><h2>Acidentes &amp; Incidentes</h2><p>Registro de ocorrências e plano de ação — 2025</p></div>
    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Ocorrências em 2025</div><div class="val">0</div><span class="delta down">↓ nenhum registro</span></div>
    </div>
    <div class="panel" style="margin-bottom:16px;">
      <h3>Demonstrativo mensal</h3>
      <div class="chart-wrap" style="height:220px;"><canvas id="ch-acidentes"></canvas></div>
    </div>
    <div class="panel">
      <h3>Plano de ação</h3>
      ${ac.acoes.length === 0 ? `
        <div class="empty-state">
          <div class="glyph">✅</div>
          <h4>Nenhum problema em aberto</h4>
          <p>Assim que houver um acidente ou incidente, cadastre aqui o problema, a ação corretiva e o responsável/prazo — essa tabela é alimentada em <code>data.js → acidentes.acoes</code>.</p>
        </div>
      ` : `
        <table>
          <thead><tr><th>Problema</th><th>Ação</th><th>Responsável/Prazo</th></tr></thead>
          <tbody>${ac.acoes.map(a=>`<tr><td>${a.problema}</td><td>${a.acao}</td><td>${a.responsavel}</td></tr>`).join("")}</tbody>
        </table>
      `}
    </div>
  `;
};
initCharts.acidentes = () => {
  const ac = DATA.acidentes;
  mkChart("ch-acidentes", {
    type:"bar",
    data:{ labels:ac.labels, datasets:[{ data:ac.valores, backgroundColor:COLORS.green, borderRadius:4 }]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
        datalabels:{ display:(ctx)=>ctx.dataset.data[ctx.dataIndex] > 0, anchor:"end", align:"top", color:COLORS.ink, font:{size:10, weight:700}, formatter:fmtLabelNum } },
      layout:{ padding:{ top:16 } },
      scales:{ y:{grid:{color:COLORS.grid}, suggestedMax:5}, x:{grid:{display:false}} } }
  });
};

/* -------------------- ENTRADA DE DADOS -------------------- */
const ENTRY_MODULES = [
  { key:"compras", ic:"🧰", label:"Compras de Peças", desc:"Lançamento diário — data, local/fornecedor, categoria e valor" },
  { key:"diesel", ic:"⛽", label:"Diesel", desc:"Custo mensal ou semanal" },
  { key:"manutencao", ic:"🔩", label:"Manutenção de Carreta", desc:"Custo mensal por tipo de serviço" },
  { key:"folha", ic:"💰", label:"Folha (Benefícios+Salário)", desc:"VT/VR, 40% adicional e salário — mensal" },
  { key:"horaextra", ic:"⏱️", label:"Hora Extra", desc:"Custo (R$) ou quantidade (horas) — mensal" },
  { key:"atestados", ic:"🩺", label:"Atestados", desc:"Ocorrências — mensal" },
  { key:"infracoes", ic:"🚨", label:"Infrações", desc:"Ocorrências mensais ou detalhe diário por turno" },
  { key:"acidentes", ic:"⚠️", label:"Acidentes & Incidentes", desc:"Ocorrências mensais ou registro de problema/ação" }
];

const CATEGORIAS_COMPRAS = ["💡 ELÉTRICA","🧱 ESTRUTURA / CABINE","🚛 SUSPENSÃO / AR","🔧 PEÇAS MECÂNICAS","🛢️ FILTROS E LUBRIFICANTES","🧪 QUÍMICOS / CONSUMO","🧰 FIXAÇÃO / METAIS","🧼 LIMPEZA / EPI","⚙️ SERVIÇOS"];

renderers.entrada = () => `
  <div class="page-head"><h2>Entrada de Dados</h2><p>Escolha a categoria, informe o período e o valor. Os gráficos e KPIs recalculam na hora — no final, baixe o <code>data.js</code> atualizado para guardar as mudanças.</p></div>

  <div class="panel" style="margin-bottom:16px; display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap;">
    <div>
      <h3 style="margin-bottom:4px;">Salvar as alterações</h3>
      <div class="hint" style="margin-bottom:0;">Isso não acontece sozinho: baixe o arquivo e substitua o <code>data.js</code> na sua pasta para não perder o que foi lançado.</div>
    </div>
    <button onclick="exportDataJs()" style="background:var(--red); color:#fff; border:none; padding:12px 20px; border-radius:10px; font-size:13px; font-weight:700; cursor:pointer; white-space:nowrap;">⬇ Baixar data.js atualizado</button>
  </div>

  <div class="tabs" id="entryModTabs">
    ${ENTRY_MODULES.map((m,i)=>`<button class="tab-btn ${i===0?"active":""}" data-mod="${m.key}">${m.ic} ${m.label}</button>`).join("")}
  </div>

  <div class="grid-2">
    <div class="panel">
      <h3 id="entryFormTitle">${ENTRY_MODULES[0].ic} ${ENTRY_MODULES[0].label}</h3>
      <div class="hint" id="entryFormDesc">${ENTRY_MODULES[0].desc}</div>
      <div id="entryFormArea"></div>
    </div>
    <div class="panel">
      <h3>Lançamentos desta sessão</h3>
      <div class="hint">Histórico do que você adicionou agora (some se recarregar a página sem exportar)</div>
      <div id="sessionLogArea"><div class="empty-state" style="padding:24px;"><div class="glyph">🕓</div><p>Nenhum lançamento ainda nesta sessão.</p></div></div>
    </div>
  </div>
`;

function renderSessionLog(){
  const el = document.getElementById("sessionLogArea");
  if(!el) return;
  if(sessionLog.length === 0){
    el.innerHTML = `<div class="empty-state" style="padding:24px;"><div class="glyph">🕓</div><p>Nenhum lançamento ainda nesta sessão.</p></div>`;
    return;
  }
  el.innerHTML = `<table><thead><tr><th>Hora</th><th>Módulo</th><th>Lançamento</th></tr></thead><tbody>
    ${sessionLog.map(l=>`<tr><td>${l.hora}</td><td>${l.modulo}</td><td>${l.descricao}</td></tr>`).join("")}
  </tbody></table>`;
}

const ENTRY_FORMS = {
  compras: () => `
    <div style="background:var(--red-soft); border:1px solid #F0B9C0; border-radius:12px; padding:16px; margin-top:12px;">
      <h4 style="font-size:13px; margin-bottom:4px;">📤 Importar planilha (.xlsx)</h4>
      <div class="hint" style="margin-bottom:10px;">
        Colunas esperadas: CAMINHÃO, COMPRADOR, APROVADOR, DATA DA COMPRA, DATA DO VENC., LOCAL DA COMPRA,
        PEÇA COMPRADAS, CATEGORIA, NF, QTDE, VALOR UNIT., TOTAL, ANO, MÊS, SEMANA, TIPO DE MANUTENÇÃO
        — a mesma estrutura da sua planilha de controle de compras.<br>
        <b>Importar substitui todo o histórico de Compras de Peças do sistema pelo conteúdo da planilha.</b>
      </div>
      <input type="file" id="ec-import-file" accept=".xlsx,.xls,.csv" style="font-size:12.5px;">
      <button class="entry-submit" style="margin-top:10px;" onclick="importComprasXlsx()">Importar e substituir</button>
      <div id="ec-import-status" class="hint" style="margin-top:10px;"></div>
    </div>
    <hr style="margin:20px 0; border:none; border-top:1px solid var(--line);">
    <div class="hint" style="margin-bottom:4px;">Ou lance uma compra avulsa manualmente:</div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px;">
      <label>Data<input type="date" id="ec-data" value="${new Date().toISOString().slice(0,10)}"></label>
      <label>Placa / Caminhão<input type="text" id="ec-placa" placeholder="Ex: GCV3D93"></label>
      <label style="grid-column:1/-1;">Local / Fornecedor<input type="text" id="ec-local" list="dl-locais" placeholder="Ex: NORTE AUTO PEÇAS"></label>
      <datalist id="dl-locais">${[...new Set(DATA.compras.comprasLancamentos.map(r=>r.l))].sort().map(l=>`<option value="${l}">`).join("")}</datalist>
      <label>Categoria<select id="ec-categoria">${CATEGORIAS_COMPRAS.map(c=>`<option>${c}</option>`).join("")}</select></label>
      <label>Valor (R$)<input type="number" id="ec-valor" step="0.01" placeholder="0,00"></label>
      <label style="grid-column:1/-1;">Item / Descrição (opcional)<input type="text" id="ec-item" placeholder="Ex: FILTRO DE ÓLEO"></label>
    </div>
    <button class="entry-submit" onclick="submitCompra()">Adicionar compra</button>
  `,
  diesel: () => `
    <div class="tabs" style="margin-top:12px;">
      <button class="sub-tab-btn active" data-sub="mensal" onclick="toggleSub(this,'diesel-mensal','diesel-semanal')">Mensal</button>
      <button class="sub-tab-btn" data-sub="semanal" onclick="toggleSub(this,'diesel-semanal','diesel-mensal')">Semanal</button>
    </div>
    <div id="diesel-mensal" style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px;">
      <label>Mês (ex: jul/26)<input type="text" id="ed-mes" list="dl-diesel-meses" placeholder="jul/26"></label>
      <datalist id="dl-diesel-meses">${DATA.diesel.mensalLabels.map(l=>`<option value="${l}">`).join("")}</datalist>
      <label>Valor (R$)<input type="number" id="ed-valor" step="0.01" placeholder="0,00"></label>
    </div>
    <div id="diesel-semanal" style="display:none; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px;">
      <label>Semana (ex: S25)<input type="text" id="ed-semana" list="dl-diesel-semanas" placeholder="S25"></label>
      <datalist id="dl-diesel-semanas">${DATA.diesel.semanalLabels.map(l=>`<option value="${l}">`).join("")}</datalist>
      <label>Valor (R$ mil)<input type="number" id="ed-valorsem" step="0.1" placeholder="Ex: 62"></label>
    </div>
    <button class="entry-submit" onclick="submitDiesel()">Adicionar</button>
  `,
  manutencao: () => `
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px;">
      <label>Mês (ex: jul/26)<input type="text" id="em-mes" list="dl-manut-meses" placeholder="jul/26"></label>
      <datalist id="dl-manut-meses">${DATA.manutencao.labels.map(l=>`<option value="${l}">`).join("")}</datalist>
      <div></div>
      <label>Manutenção Geral (R$)<input type="number" id="em-geral" step="0.01" placeholder="0,00"></label>
      <label>Pintura do Teto (R$)<input type="number" id="em-pintura" step="0.01" placeholder="0,00"></label>
      <label>Outros Serviços (R$)<input type="number" id="em-outros" step="0.01" placeholder="0,00"></label>
    </div>
    <button class="entry-submit" onclick="submitManutencao()">Adicionar / atualizar mês</button>
  `,
  folha: () => `
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px;">
      <label>Mês (ex: jul/26)<input type="text" id="ef-mes" list="dl-folha-meses" placeholder="jul/26"></label>
      <datalist id="dl-folha-meses">${DATA.folha.labels.map(l=>`<option value="${l}">`).join("")}</datalist>
      <div></div>
      <label>VT + VR (R$ mil)<input type="number" id="ef-vtvr" step="0.1" placeholder="Ex: 76"></label>
      <label>40% Adicional (R$ mil)<input type="number" id="ef-ad40" step="0.1" placeholder="Ex: 111.3"></label>
      <label>Salário (R$ mil)<input type="number" id="ef-salario" step="0.1" placeholder="Ex: 194.2"></label>
    </div>
    <button class="entry-submit" onclick="submitFolha()">Adicionar / atualizar mês</button>
    <hr style="margin:18px 0; border:none; border-top:1px solid var(--line);">
    <div class="hint" style="margin-bottom:10px;">Totais anuais dos cards de KPI (vêm do fechamento do RH — só mude se tiver o número novo)</div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
      <label>Total anual 2025 (Mi)<input type="number" id="ef-tot25" step="0.001" placeholder="Ex: 1.084" value="${DATA.folha.totalSalario2025_M}"></label>
      <label>Total anual 2026 (Mi)<input type="number" id="ef-tot26" step="0.001" placeholder="Ex: 1.533" value="${DATA.folha.totalSalario2026_M}"></label>
    </div>
    <button class="entry-submit" onclick="submitFolhaAnual()">Atualizar totais anuais</button>
  `,
  horaextra: () => `
    <div class="tabs" style="margin-top:12px;">
      <button class="sub-tab-btn active" data-sub="custo" onclick="toggleSub(this,'he-custo','he-qtd')">Custo (R$)</button>
      <button class="sub-tab-btn" data-sub="qtd" onclick="toggleSub(this,'he-qtd','he-custo')">Quantidade (horas)</button>
    </div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px;">
      <label>Ano<select id="eh-ano"><option value="2025">2025</option><option value="2026" selected>2026</option></select></label>
      <label>Mês<select id="eh-mes">${MONTH_ABBR.map(m=>`<option>${m}</option>`).join("")}</select></label>
    </div>
    <div id="he-custo" style="margin-top:12px;">
      <label>Valor (R$)<input type="number" id="eh-valor-custo" step="0.01" placeholder="0,00"></label>
    </div>
    <div id="he-qtd" style="display:none; margin-top:12px;">
      <label>Horas<input type="number" id="eh-valor-qtd" step="1" placeholder="Ex: 95"></label>
    </div>
    <button class="entry-submit" onclick="submitHoraExtra()">Adicionar / atualizar mês</button>
  `,
  atestados: () => `
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px;">
      <label>Mês (ex: jun/26)<input type="text" id="ea-mes" list="dl-atest-meses" placeholder="jun/26"></label>
      <datalist id="dl-atest-meses">${DATA.atestados.labels.map(l=>`<option value="${l}">`).join("")}</datalist>
      <label>Ocorrências<input type="number" id="ea-valor" step="1" placeholder="Ex: 18"></label>
    </div>
    <button class="entry-submit" onclick="submitAtestado()">Adicionar / atualizar mês</button>
  `,
  infracoes: () => `
    <div class="tabs" style="margin-top:12px;">
      <button class="sub-tab-btn active" data-sub="mensal" onclick="toggleSub(this,'inf-mensal','inf-diario')">Mensal</button>
      <button class="sub-tab-btn" data-sub="diario" onclick="toggleSub(this,'inf-diario','inf-mensal')">Diário</button>
    </div>
    <div id="inf-mensal" style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px;">
      <label>Mês (ex: jul/26)<input type="text" id="ei-mes" list="dl-inf-meses" placeholder="jul/26"></label>
      <datalist id="dl-inf-meses">${DATA.infracoes.labels.map(l=>`<option value="${l}">`).join("")}</datalist>
      <label>Ocorrências<input type="number" id="ei-valor" step="1" placeholder="Ex: 30"></label>
    </div>
    <div id="inf-diario" style="display:none; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px;">
      <label>Data (ex: 18/jun)<input type="text" id="ei-data" placeholder="18/jun"></label>
      <div></div>
      <label>1º Turno<input type="number" id="ei-turno1" step="1" placeholder="0"></label>
      <label>2º Turno<input type="number" id="ei-turno2" step="1" placeholder="0"></label>
    </div>
    <button class="entry-submit" onclick="submitInfracao()">Adicionar</button>
  `,
  acidentes: () => `
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px;">
      <label>Mês<select id="eac-mes">${MONTH_ABBR.map(m=>`<option>${m}</option>`).join("")}</select></label>
      <label>Ocorrências<input type="number" id="eac-valor" step="1" placeholder="0"></label>
    </div>
    <button class="entry-submit" onclick="submitAcidenteMes()">Adicionar / atualizar mês</button>
    <hr style="margin:18px 0; border:none; border-top:1px solid var(--line);">
    <div style="display:grid; gap:12px;">
      <label>Problema<input type="text" id="eac-problema" placeholder="Descreva o problema"></label>
      <label>Ação<input type="text" id="eac-acao" placeholder="Ação corretiva"></label>
      <label>Responsável / Prazo<input type="text" id="eac-resp" placeholder="Ex: George — 15/08"></label>
    </div>
    <button class="entry-submit" onclick="submitAcidenteAcao()">Adicionar ao plano de ação</button>
  `
};

function mountEntryForm(mod){
  const meta = ENTRY_MODULES.find(m=>m.key===mod);
  document.getElementById("entryFormTitle").textContent = `${meta.ic} ${meta.label}`;
  document.getElementById("entryFormDesc").textContent = meta.desc;
  document.getElementById("entryFormArea").innerHTML = ENTRY_FORMS[mod]();
}
window.toggleSub = (btn, showId, hideId) => {
  btn.parentElement.querySelectorAll(".sub-tab-btn").forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById(showId).style.display = "grid";
  document.getElementById(hideId).style.display = "none";
};

// Converte data do Excel (Date object, já que lemos com cellDates:true) para "YYYY-MM-DD" local, sem shift de fuso.
function excelDateToISO(d){
  if(!(d instanceof Date) || isNaN(d)) return null;
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,"0"), day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}

window.importComprasXlsx = async () => {
  const fileInput = document.getElementById("ec-import-file");
  const statusEl = document.getElementById("ec-import-status");
  const file = fileInput.files[0];
  if(!file){ statusEl.textContent = "⚠ Selecione um arquivo primeiro."; return; }
  if(typeof XLSX === "undefined"){ statusEl.textContent = "⚠ Biblioteca de planilhas não carregada (confira se xlsx.full.min.js está na pasta)."; return; }

  statusEl.textContent = "Lendo planilha...";
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type:"array", cellDates:true });

    // Procura, em qualquer aba, a linha de cabeçalho que contenha "CAMINHÃO"
    let headerRow = null, sheetRows = null;
    for(const name of wb.SheetNames){
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header:1, defval:null });
      for(let i=0;i<Math.min(rows.length,15);i++){
        const r = rows[i];
        if(r && r[0] && String(r[0]).trim().toUpperCase().indexOf("CAMINH") === 0){
          headerRow = r; sheetRows = rows.slice(i+1); break;
        }
      }
      if(headerRow) break;
    }
    if(!headerRow){
      statusEl.textContent = "⚠ Não encontrei a linha de cabeçalho (esperava uma coluna 'CAMINHÃO'). Confira se é a mesma estrutura da planilha de controle.";
      return;
    }

    const idx = {};
    headerRow.forEach((h,i)=>{ if(h!=null) idx[String(h).trim().toUpperCase()] = i; });
    const col = (name) => idx[name];
    const cData = col("DATA DA COMPRA"), cLocal = col("LOCAL DA COMPRA"), cCam = col("CAMINHÃO"),
          cCat = col("CATEGORIA"), cPeca = col("PEÇA COMPRADAS"), cTotal = col("TOTAL");

    if(cData==null || cTotal==null || cCam==null){
      statusEl.textContent = "⚠ Faltam colunas essenciais (CAMINHÃO, DATA DA COMPRA ou TOTAL). Confira o cabeçalho da planilha.";
      return;
    }

    const novos = [];
    let manutCount = 0, manutSoma = 0, ignoradas = 0;
    sheetRows.forEach(r=>{
      if(!r) return;
      const dataRaw = r[cData], total = r[cTotal];
      if(dataRaw == null || total == null || total === "") { ignoradas++; return; }
      const iso = excelDateToISO(dataRaw);
      if(!iso){ ignoradas++; return; }
      const placa = (r[cCam]||"").toString().trim();
      const valor = parseFloat(total);
      if(isNaN(valor)){ ignoradas++; return; }
      if(placa.toUpperCase() === "MANUTENÇÃO" || placa.toUpperCase() === "MANUTENCAO"){
        manutCount++; manutSoma += valor; return; // não faz parte de Compras de Peças
      }
      novos.push({
        d: iso,
        p: placa,
        l: (cLocal!=null ? (r[cLocal]||"").toString().trim() : "") || "Não informado",
        c: (cCat!=null ? (r[cCat]||"").toString().trim() : "") || "Sem categoria",
        i: (cPeca!=null ? (r[cPeca]||"").toString().trim() : "") || "—",
        v: valor
      });
    });

    if(novos.length === 0){
      statusEl.textContent = "⚠ Nenhum lançamento válido encontrado na planilha.";
      return;
    }

    DATA.compras.comprasLancamentos = novos;
    deriveCompras();
    logEntry("Compras (importação)", `${novos.length} lançamentos importados de "${file.name}"`);
    toast(`✓ ${novos.length} lançamentos importados`);
    renderSessionLog();

    const datas = novos.map(r=>r.d).sort();
    statusEl.innerHTML = `✓ <b>${fmtNum(novos.length)}</b> lançamentos importados (${datas[0].split("-").reverse().join("/")} a ${datas[datas.length-1].split("-").reverse().join("/")}), total ${fmtBRL(novos.reduce((s,r)=>s+r.v,0))}.` +
      (manutCount>0 ? `<br>${manutCount} linhas com placa "MANUTENÇÃO" (${fmtBRL(manutSoma)}) foram ignoradas — pertencem ao módulo de Manutenção de Carreta, não a Compras de Peças.` : "") +
      (ignoradas>0 ? `<br>${ignoradas} linha(s) sem data ou valor válido foram ignoradas.` : "");

    if(document.querySelector('nav.menu button.active')?.dataset.page === "compras") navigate("compras");
  }catch(e){
    console.error(e);
    statusEl.textContent = "⚠ Erro ao ler o arquivo: " + e.message;
  }
};

window.submitCompra = () => {
  const d = document.getElementById("ec-data").value;
  const v = parseFloat(document.getElementById("ec-valor").value);
  if(!d || isNaN(v)){ toast("Preencha data e valor."); return; }
  DATA.compras.comprasLancamentos.push({
    d, p:document.getElementById("ec-placa").value.trim(), l:document.getElementById("ec-local").value.trim()||"Não informado",
    c:document.getElementById("ec-categoria").value, i:document.getElementById("ec-item").value.trim()||"—", v
  });
  deriveCompras();
  logEntry("Compras de Peças", `${d.split("-").reverse().join("/")} · ${fmtBRL2(v)}`);
  toast("Compra adicionada ✓");
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "compras") navigate("compras");
};

window.submitDiesel = () => {
  const mensalOn = document.getElementById("diesel-mensal").style.display !== "none";
  if(mensalOn){
    const label = document.getElementById("ed-mes").value.trim();
    const v = parseFloat(document.getElementById("ed-valor").value);
    if(!label || isNaN(v)){ toast("Preencha mês e valor."); return; }
    upsertPeriod(DATA.diesel, "mensalLabels", label, { mensal:v });
    recomputeDiesel();
    logEntry("Diesel (mensal)", `${label} · ${fmtBRL(v)}`);
  } else {
    const label = document.getElementById("ed-semana").value.trim();
    const v = parseFloat(document.getElementById("ed-valorsem").value);
    if(!label || isNaN(v)){ toast("Preencha semana e valor."); return; }
    upsertPeriod(DATA.diesel, "semanalLabels", label, { semanal_x1000:v });
    recomputeDiesel();
    logEntry("Diesel (semanal)", `${label} · ${v}K`);
  }
  toast("Diesel atualizado ✓");
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "diesel") navigate("diesel");
};

window.submitManutencao = () => {
  const label = document.getElementById("em-mes").value.trim();
  const g = parseFloat(document.getElementById("em-geral").value) || 0;
  const p = parseFloat(document.getElementById("em-pintura").value) || 0;
  const o = parseFloat(document.getElementById("em-outros").value) || 0;
  if(!label){ toast("Informe o mês."); return; }
  upsertPeriod(DATA.manutencao, "labels", label, { manutencaoGeral:g, pinturaTeto:p, outrosServicos:o });
  recomputeManutencao();
  logEntry("Manutenção de Carreta", `${label} · ${fmtBRL(g+p+o)}`);
  toast("Manutenção atualizada ✓");
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "manutencao") navigate("manutencao");
};

window.submitFolha = () => {
  const label = document.getElementById("ef-mes").value.trim();
  const vt = parseFloat(document.getElementById("ef-vtvr").value) || 0;
  const ad = parseFloat(document.getElementById("ef-ad40").value) || 0;
  const sal = parseFloat(document.getElementById("ef-salario").value) || 0;
  if(!label){ toast("Informe o mês."); return; }
  upsertPeriod(DATA.folha, "labels", label, { vtVr:vt, ad40:ad, salario:sal });
  recomputeFolha();
  logEntry("Folha", `${label} · total salário ${(ad+sal).toFixed(1)} mil`);
  toast("Folha atualizada ✓");
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "folha") navigate("folha");
};

window.submitFolhaAnual = () => {
  const v25 = parseFloat(document.getElementById("ef-tot25").value);
  const v26 = parseFloat(document.getElementById("ef-tot26").value);
  updateFolhaAnual(isNaN(v25)?null:v25, isNaN(v26)?null:v26);
  logEntry("Folha (totais anuais)", `2025: ${DATA.folha.totalSalario2025_M} Mi · 2026: ${DATA.folha.totalSalario2026_M} Mi`);
  toast("Totais anuais atualizados ✓");
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "folha") navigate("folha");
};

window.submitHoraExtra = () => {
  const ano = document.getElementById("eh-ano").value;
  const mes = document.getElementById("eh-mes").value;
  const idx = MONTH_ABBR.indexOf(mes);
  const custoOn = document.getElementById("he-custo").style.display !== "none";
  if(custoOn){
    const v = parseFloat(document.getElementById("eh-valor-custo").value);
    if(isNaN(v)){ toast("Informe o valor."); return; }
    DATA.horaExtraCusto[ano==="2025"?"y2025":"y2026"][idx] = v;
    recomputeHoraExtraCusto();
    logEntry("Hora Extra (custo)", `${mes}/${ano} · ${fmtBRL(v)}`);
  } else {
    const v = parseFloat(document.getElementById("eh-valor-qtd").value);
    if(isNaN(v)){ toast("Informe as horas."); return; }
    DATA.horaExtraQtd[ano==="2025"?"y2025":"y2026"][idx] = v;
    recomputeHoraExtraQtd();
    logEntry("Hora Extra (horas)", `${mes}/${ano} · ${v}h`);
  }
  toast("Hora extra atualizada ✓");
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "horaextra") navigate("horaextra");
};

window.submitAtestado = () => {
  const label = document.getElementById("ea-mes").value.trim();
  const v = parseInt(document.getElementById("ea-valor").value);
  if(!label || isNaN(v)){ toast("Preencha mês e ocorrências."); return; }
  upsertPeriod(DATA.atestados, "labels", label, { ocorrencias:v });
  logEntry("Atestados", `${label} · ${v} ocorrência(s)`);
  toast("Atestados atualizado ✓");
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "atestados") navigate("atestados");
};

window.submitInfracao = () => {
  const mensalOn = document.getElementById("inf-mensal").style.display !== "none";
  if(mensalOn){
    const label = document.getElementById("ei-mes").value.trim();
    const v = parseInt(document.getElementById("ei-valor").value);
    if(!label || isNaN(v)){ toast("Preencha mês e ocorrências."); return; }
    upsertPeriod(DATA.infracoes, "labels", label, { ocorrencias:v });
    recomputeInfracoes();
    logEntry("Infrações (mensal)", `${label} · ${v} ocorrência(s)`);
  } else {
    const label = document.getElementById("ei-data").value.trim();
    const t1 = parseInt(document.getElementById("ei-turno1").value) || 0;
    const t2 = parseInt(document.getElementById("ei-turno2").value) || 0;
    if(!label){ toast("Informe a data."); return; }
    upsertPeriod(DATA.infracoes.diario, "labels", label, { turno1:t1, turno2:t2 });
    logEntry("Infrações (diário)", `${label} · T1:${t1} T2:${t2}`);
  }
  toast("Infrações atualizado ✓");
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "infracoes") navigate("infracoes");
};

window.submitAcidenteMes = () => {
  const mes = document.getElementById("eac-mes").value;
  const v = parseInt(document.getElementById("eac-valor").value);
  if(isNaN(v)){ toast("Informe a quantidade."); return; }
  const idx = DATA.acidentes.labels.indexOf(mes);
  if(idx>=0) DATA.acidentes.valores[idx] = v;
  logEntry("Acidentes", `${mes} · ${v} ocorrência(s)`);
  toast("Acidentes atualizado ✓");
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "acidentes") navigate("acidentes");
};
window.submitAcidenteAcao = () => {
  const problema = document.getElementById("eac-problema").value.trim();
  const acao = document.getElementById("eac-acao").value.trim();
  const responsavel = document.getElementById("eac-resp").value.trim();
  if(!problema){ toast("Descreva o problema."); return; }
  DATA.acidentes.acoes.push({ problema, acao, responsavel });
  logEntry("Acidentes (plano de ação)", problema);
  toast("Ação adicionada ✓");
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "acidentes") navigate("acidentes");
};

initCharts.entrada = () => {
  mountEntryForm("compras");
  renderSessionLog();
  document.getElementById("entryModTabs").addEventListener("click", (e)=>{
    const btn = e.target.closest(".tab-btn");
    if(!btn) return;
    document.querySelectorAll("#entryModTabs .tab-btn").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");
    mountEntryForm(btn.dataset.mod);
  });
};

/* ---------- Inicialização ---------- */
deriveCompras();
navigate("overview");
