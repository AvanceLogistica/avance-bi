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

/* ============================================================================
   CONEXÃO COM O SUPABASE (banco de dados)
   ============================================================================ */
const sb = (typeof supabase !== "undefined" && typeof SUPABASE_URL !== "undefined" && SUPABASE_URL)
  ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;
let SUPABASE_SINCRONIZADO = false; // true assim que carregarmos dados reais do banco com sucesso

async function sbFetchAll(table){
  if(!sb) return [];
  let all = [], from = 0;
  const pageSize = 1000;
  while(true){
    const { data, error } = await sb.from(table).select("*").range(from, from + pageSize - 1);
    if(error){ console.warn("Erro ao buscar", table, error); break; }
    all = all.concat(data);
    if(!data.length || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function sbBulkInsert(table, rows){
  if(!rows.length) return;
  const chunkSize = 500;
  for(let i=0;i<rows.length;i+=chunkSize){
    const { error } = await sb.from(table).insert(rows.slice(i, i+chunkSize));
    if(error) throw error;
  }
}

function setMonthValue(arr, label, val, labelsArr){
  const labels = labelsArr || MONTH_ABBR;
  const idx = labels.indexOf(label);
  if(idx>=0) arr[idx] = val;
}

// Aplica as linhas de series_periodo (vindas do Supabase) por cima do DATA já carregado do data.js.
function applySeriesPeriodo(rows){
  rows.forEach(r=>{
    const val = Number(r.valor);
    switch(r.modulo){
      case "manutencao": upsertPeriod(DATA.manutencao, "labels", r.label, { [r.campo]: val }); break;
      case "diesel_mensal": upsertPeriod(DATA.diesel, "mensalLabels", r.label, { mensal: val }); break;
      case "diesel_semanal": upsertPeriod(DATA.diesel, "semanalLabels", r.label, { semanal_x1000: val }); break;
      case "folha": upsertPeriod(DATA.folha, "labels", r.label, { [r.campo]: val }); break;
      case "horaextra_custo_2025": setMonthValue(DATA.horaExtraCusto.y2025, r.label, val); break;
      case "horaextra_custo_2026": setMonthValue(DATA.horaExtraCusto.y2026, r.label, val); break;
      case "horaextra_qtd_2025": setMonthValue(DATA.horaExtraQtd.y2025, r.label, val); break;
      case "horaextra_qtd_2026": setMonthValue(DATA.horaExtraQtd.y2026, r.label, val); break;
      case "atestados": upsertPeriod(DATA.atestados, "labels", r.label, { ocorrencias: val }); break;
      case "infracoes": upsertPeriod(DATA.infracoes, "labels", r.label, { ocorrencias: val }); break;
      case "acidentes": setMonthValue(DATA.acidentes.valores, r.label, val, DATA.acidentes.labels); break;
    }
  });
  recomputeManutencao(); recomputeDiesel(); recomputeFolha();
  recomputeHoraExtraCusto(); recomputeInfracoes();
}
function applyEventosDiarios(rows){
  rows.forEach(r=>{
    if(r.modulo === "infracoes_diario"){
      upsertPeriod(DATA.infracoes.diario, "labels", r.label, { [r.campo]: Number(r.valor) });
    }
  });
}

// Busca tudo do banco e substitui/atualiza o DATA local. Retorna true se havia dados no banco.
async function loadFromSupabase(){
  if(!sb) return false;
  try{
    const [compras, contas, series, diarios, acoes, manutLanc] = await Promise.all([
      sbFetchAll("compras_lancamentos"),
      sbFetchAll("contas_pagar"),
      sbFetchAll("series_periodo"),
      sbFetchAll("eventos_diarios"),
      sbFetchAll("acidentes_acoes"),
      sbFetchAll("manutencao_lancamentos")
    ]);

    if(!compras.length && !contas.length && !series.length) return false; // banco ainda vazio

    if(compras.length){
      DATA.compras.comprasLancamentos = compras.map(r=>({ id:r.id, d:r.data, p:r.placa||"", l:r.local||"", c:r.categoria||"", i:r.item||"", v:Number(r.valor) }));
    }
    if(contas.length){
      DATA.contasPagar.lancamentos = contas.map(r=>({
        id:r.id, prestador:r.prestador, cnpj:r.cnpj, tipoServico:r.tipo_servico, valor:Number(r.valor),
        formaPagamento:r.forma_pagamento, dataEmissao:r.data_emissao, dataVencimento:r.data_vencimento,
        numeroDocumento:r.numero_documento, status:r.status, dataPagamento:r.data_pagamento
      }));
    }
    applySeriesPeriodo(series);
    applyEventosDiarios(diarios);
    if(acoes.length) DATA.acidentes.acoes = acoes.map(a=>({ id:a.id, problema:a.problema, acao:a.acao, responsavel:a.responsavel }));
    if(manutLanc.length){
      DATA.manutencao.lancamentos = manutLanc.map(r=>({
        id:r.id, d:r.data, placa:r.placa||"", local:r.local||"", nf:r.nf||"", os:r.os||"",
        frota:r.frota||"", servico:r.servico||"", status:r.status||"", v:Number(r.valor)
      }));
    }

    deriveCompras();
    deriveManutencao();
    return true;
  }catch(e){
    console.warn("Falha ao carregar do Supabase, mantendo dados locais:", e);
    return false;
  }
}

// Envia TUDO que está em DATA (vindo do data.js) para o Supabase — só deve ser usado uma vez,
// para popular o banco pela primeira vez. Ver botão "Migrar dados para o Supabase".
async function migrarParaSupabase(onProgress){
  const say = (msg) => { if(onProgress) onProgress(msg); };
  if(!sb){ say("⚠ Conexão com Supabase não configurada."); return; }

  say("Enviando Contas a Pagar...");
  const contasRows = DATA.contasPagar.lancamentos.map(i=>({
    prestador:i.prestador, cnpj:i.cnpj, tipo_servico:i.tipoServico, valor:i.valor, forma_pagamento:i.formaPagamento,
    data_emissao:i.dataEmissao, data_vencimento:i.dataVencimento, numero_documento:i.numeroDocumento,
    status:i.status, data_pagamento:i.dataPagamento
  }));
  if(contasRows.length){ const { error } = await sb.from("contas_pagar").insert(contasRows); if(error) throw error; }

  say(`Enviando ${fmtNum(DATA.compras.comprasLancamentos.length)} lançamentos de Compras de Peças (pode levar um minuto)...`);
  const comprasRows = DATA.compras.comprasLancamentos.map(r=>({ data:r.d, placa:r.p, local:r.l, categoria:r.c, item:r.i, valor:r.v }));
  await sbBulkInsert("compras_lancamentos", comprasRows);

  if(DATA.manutencao.lancamentos.length){
    say(`Enviando ${fmtNum(DATA.manutencao.lancamentos.length)} lançamentos de Manutenção de Carreta...`);
    const manutRows = DATA.manutencao.lancamentos.map(r=>({ data:r.d, placa:r.placa, local:r.local, nf:r.nf, os:r.os, frota:r.frota, servico:r.servico, status:r.status, valor:r.v }));
    await sbBulkInsert("manutencao_lancamentos", manutRows);
  }

  say("Enviando séries mensais (Manutenção, Diesel, Folha, Hora Extra, Atestados, Infrações, Acidentes)...");
  const seriesRows = [];
  const pushSeries = (modulo, labels, camposMap) => {
    labels.forEach((label,idx)=>{
      Object.entries(camposMap).forEach(([campo, arr])=>{
        const v = arr[idx];
        if(v!=null) seriesRows.push({ modulo, campo, label, valor:v });
      });
    });
  };
  pushSeries("manutencao", DATA.manutencao.labels, { manutencaoGeral:DATA.manutencao.manutencaoGeral, pinturaTeto:DATA.manutencao.pinturaTeto, outrosServicos:DATA.manutencao.outrosServicos });
  pushSeries("diesel_mensal", DATA.diesel.mensalLabels, { mensal:DATA.diesel.mensal });
  pushSeries("diesel_semanal", DATA.diesel.semanalLabels, { semanal_x1000:DATA.diesel.semanal_x1000 });
  pushSeries("folha", DATA.folha.labels, { vtVr:DATA.folha.vtVr, ad40:DATA.folha.ad40, salario:DATA.folha.salario });
  pushSeries("horaextra_custo_2025", MONTH_ABBR, { valor:DATA.horaExtraCusto.y2025 });
  pushSeries("horaextra_custo_2026", MONTH_ABBR, { valor:DATA.horaExtraCusto.y2026 });
  pushSeries("horaextra_qtd_2025", MONTH_ABBR, { valor:DATA.horaExtraQtd.y2025 });
  pushSeries("horaextra_qtd_2026", MONTH_ABBR, { valor:DATA.horaExtraQtd.y2026 });
  pushSeries("atestados", DATA.atestados.labels, { ocorrencias:DATA.atestados.ocorrencias });
  pushSeries("infracoes", DATA.infracoes.labels, { ocorrencias:DATA.infracoes.ocorrencias });
  pushSeries("acidentes", DATA.acidentes.labels, { valores:DATA.acidentes.valores });
  await sbBulkInsert("series_periodo", seriesRows);

  say("Enviando eventos diários de Infrações...");
  const diariosRows = [];
  DATA.infracoes.diario.labels.forEach((label,idx)=>{
    diariosRows.push({ modulo:"infracoes_diario", campo:"turno1", label, valor: DATA.infracoes.diario.turno1[idx]||0 });
    diariosRows.push({ modulo:"infracoes_diario", campo:"turno2", label, valor: DATA.infracoes.diario.turno2[idx]||0 });
  });
  await sbBulkInsert("eventos_diarios", diariosRows);

  say("Enviando plano de ação de Acidentes...");
  if(DATA.acidentes.acoes.length){
    const { error } = await sb.from("acidentes_acoes").insert(DATA.acidentes.acoes.map(a=>({ problema:a.problema, acao:a.acao, responsavel:a.responsavel })));
    if(error) throw error;
  }

  say("Recarregando do banco pra confirmar tudo certo...");
  await loadFromSupabase();
  SUPABASE_SINCRONIZADO = true;

  say(`✅ Migração concluída! ${fmtNum(comprasRows.length)} compras, ${contasRows.length} conta(s) a pagar, ${fmtNum(seriesRows.length)} pontos de série.`);
}

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

// Status calculado de uma conta a pagar: Pago (já quitada) / Vencida (passou do vencimento) / A vencer.
function statusConta(c){
  if(c.status === "Pago") return "Pago";
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const venc = new Date(c.dataVencimento + "T00:00:00");
  return venc < hoje ? "Vencido" : "A vencer";
}
function statusBadgeClass(s){ return s === "Pago" ? "green" : (s === "Vencido" ? "red" : "amber"); }
function fmtDataBR(iso){ return iso ? iso.split("-").reverse().join("/") : "—"; }
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
const pages = ["overview","entrada","manutencao","diesel","folha","horaextra","compras","atestados","infracoes","acidentes","contaspagar"];
const titles = {
  overview: ["Painel Executivo","Consolidado de indicadores · Avance Transporte Logístico"],
  entrada: ["Entrada de Dados","Lance valores por dia, semana ou mês — os gráficos atualizam na hora"],
  contaspagar: ["Contas a Pagar","Prestadores de serviço — vencimentos, status e forma de pagamento"],
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

// Acessa DATA por um caminho tipo "horaExtraCusto.y2026" — usado pelos descritores de "desfazer"
// abaixo, que precisam ser puro JSON (serializável em localStorage) pra sobreviver a um F5.
function getByPath(path){
  return path.split(".").reduce((o,k)=> o ? o[k] : undefined, DATA);
}
// Funções de recálculo referenciáveis por nome (um descritor salvo em localStorage não pode
// guardar uma função direto, só o nome dela).
const RECOMPUTE_FN = { recomputeDiesel, recomputeManutencao, recomputeFolha, recomputeHoraExtraCusto, recomputeHoraExtraQtd, recomputeInfracoes, deriveCompras, deriveManutencao };

// Monta um DESCRITOR (objeto simples, serializável) de "desfazer" para um lançamento por período
// (Diesel, Manutenção, Folha, Atestados, Infrações). Guarda o estado de ANTES do upsertPeriod: se o
// período já existia, restaura os valores antigos; se era novo, remove a linha inteira.
// Chame ANTES de chamar upsertPeriod.
function prepararDesfazerPeriodo(containerPath, labelsKey, label, campos, recomputeName, sbTable, sbRowsBase){
  const container = getByPath(containerPath);
  const labels = container[labelsKey];
  const idx = labels.indexOf(label);
  const existed = idx !== -1;
  const anteriores = {};
  if(existed) campos.forEach(c=>{ anteriores[c] = (container[c] && container[c][idx]!=null) ? container[c][idx] : null; });
  return { kind:"periodo", containerPath, labelsKey, label, campos, existed, anteriores, recomputeName, sbTable, sbRowsBase };
}

// Mesma ideia, mas para séries de índice fixo (Hora Extra, Acidentes por mês) onde o "lançamento"
// só substitui o valor de um mês que já existe no array — nunca cria nem remove posição.
function prepararDesfazerIndice(containerPath, idx, recomputeName, sbRow){
  const arr = getByPath(containerPath);
  return { kind:"indice", containerPath, idx, anterior: arr[idx]!=null ? arr[idx] : null, recomputeName, sbRow };
}

// Descritor de "desfazer" para uma linha nova numa lista (Compras de Peças, Contas a Pagar,
// Acidentes · plano de ação) — encontra a linha pelo id local/do banco, não por referência de
// objeto, pra funcionar mesmo depois de recarregar a página.
function prepararDesfazerArrayById(containerPath, itemId, sbTable){
  return { kind:"arrayById", containerPath, itemId, sbId:null, sbTable };
}
function localId(){
  return (crypto.randomUUID ? crypto.randomUUID() : ("id_" + Date.now() + "_" + Math.random().toString(36).slice(2)));
}

// Executa um descritor de "desfazer" (chamado ao clicar em Excluir no histórico de lançamentos —
// pode ser um descritor recém-criado nesta sessão ou um recarregado do localStorage após um F5).
async function executarUndo(d){
  if(!d) return;
  if(d.kind === "periodo"){
    const container = getByPath(d.containerPath);
    const labels = container[d.labelsKey];
    const i = labels.indexOf(d.label);
    if(i === -1) return;
    if(d.existed){
      d.campos.forEach(c=>{ if(container[c]) container[c][i] = d.anteriores[c]; });
    } else {
      labels.splice(i,1);
      d.campos.forEach(c=>{ if(container[c]) container[c].splice(i,1); });
    }
    if(d.recomputeName && RECOMPUTE_FN[d.recomputeName]) RECOMPUTE_FN[d.recomputeName]();
    if(sb && d.sbTable && d.sbRowsBase){
      if(d.existed){
        await sb.from(d.sbTable).upsert(d.sbRowsBase.map(r=>({ ...r, valor: d.anteriores[r.campo] })), { onConflict:"modulo,campo,label" });
      } else {
        for(const r of d.sbRowsBase) await sb.from(d.sbTable).delete().match({ modulo:r.modulo, campo:r.campo, label:r.label });
      }
    }
  } else if(d.kind === "indice"){
    const arr = getByPath(d.containerPath);
    arr[d.idx] = d.anterior;
    if(d.recomputeName && RECOMPUTE_FN[d.recomputeName]) RECOMPUTE_FN[d.recomputeName]();
    if(sb && d.sbRow) await sb.from("series_periodo").upsert({ ...d.sbRow, valor:d.anterior }, { onConflict:"modulo,campo,label" });
  } else if(d.kind === "arrayById"){
    const arr = getByPath(d.containerPath);
    const i = arr.findIndex(r=>r.id === d.itemId);
    if(i>=0) arr.splice(i,1);
    if(d.containerPath === "compras.comprasLancamentos") deriveCompras();
    else if(d.containerPath === "manutencao.lancamentos") deriveManutencao();
    if(sb && d.sbTable && d.sbId) await sb.from(d.sbTable).delete().eq("id", d.sbId);
  } else if(d.kind === "folhaAnual"){
    updateFolhaAnual(d.anterior25, d.anterior26);
  } else if(d.kind === "bulkImportCompras"){
    DATA.compras.comprasLancamentos = d.anteriores;
    deriveCompras();
    if(sb){
      await sb.from("compras_lancamentos").delete().not("id","is",null);
      if(d.anteriores.length) await sbBulkInsert("compras_lancamentos", d.anteriores.map(r=>({ data:r.d, placa:r.p, local:r.l, categoria:r.c, item:r.i, valor:r.v })));
    }
  } else if(d.kind === "bulkImportManutencao"){
    DATA.manutencao.lancamentos = d.anteriores;
    deriveManutencao();
    if(sb){
      await sb.from("manutencao_lancamentos").delete().not("id","is",null);
      if(d.anteriores.length) await sbBulkInsert("manutencao_lancamentos", d.anteriores.map(r=>({ data:r.d, placa:r.placa, local:r.local, nf:r.nf, os:r.os, frota:r.frota, servico:r.servico, status:r.status, valor:r.v })));
    }
  }
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

// Decide em qual dos 3 grupos do módulo Manutenção um serviço entra, a partir do texto livre da
// coluna "Serviço" da planilha (ou do valor escolhido no formulário avulso, que já vem exato).
function categorizarServicoManutencao(servico){
  const s = (servico||"").toUpperCase();
  if(s.includes("PINTURA")) return "pinturaTeto";
  if(s.includes("GERAL")) return "manutencaoGeral";
  return "outrosServicos";
}

// Snapshot dos totais mensais de Manutenção como vieram do data.js, capturado uma única vez no
// carregamento da página — é pra onde deriveManutencao() volta se todos os lançamentos
// transacionais (avulsos ou de importação) forem excluídos, pra nunca ficar com tela em branco.
const MANUTENCAO_BASELINE_AGREGADOS = {
  labels: [...DATA.manutencao.labels], manutencaoGeral: [...DATA.manutencao.manutencaoGeral],
  pinturaTeto: [...DATA.manutencao.pinturaTeto], outrosServicos: [...DATA.manutencao.outrosServicos],
  totalGeral: [...DATA.manutencao.totalGeral], totalPeriodo: DATA.manutencao.totalPeriodo,
  composicao: DATA.manutencao.composicao.map(c=>({ ...c }))
};

// Recalcula os totais mensais do módulo Manutenção a partir dos lançamentos individuais — mesma
// lógica do deriveCompras() acima. Só entra em ação depois do primeiro lançamento (avulso ou por
// importação de planilha); até lá (ou se todos forem excluídos de novo), os valores originais do
// data.js continuam valendo. A partir do primeiro lançamento, eles passam a ser a fonte única da verdade.
function deriveManutencao(){
  const m = DATA.manutencao;
  if(!Array.isArray(m.lancamentos)) m.lancamentos = [];
  if(m.lancamentos.length === 0){
    m.labels = [...MANUTENCAO_BASELINE_AGREGADOS.labels];
    m.manutencaoGeral = [...MANUTENCAO_BASELINE_AGREGADOS.manutencaoGeral];
    m.pinturaTeto = [...MANUTENCAO_BASELINE_AGREGADOS.pinturaTeto];
    m.outrosServicos = [...MANUTENCAO_BASELINE_AGREGADOS.outrosServicos];
    m.totalGeral = [...MANUTENCAO_BASELINE_AGREGADOS.totalGeral];
    m.totalPeriodo = MANUTENCAO_BASELINE_AGREGADOS.totalPeriodo;
    m.composicao = MANUTENCAO_BASELINE_AGREGADOS.composicao.map(c=>({ ...c }));
    return;
  }

  const monthMap = {};
  m.lancamentos.forEach(r=>{
    const ym = r.d.slice(0,7);
    if(!monthMap[ym]) monthMap[ym] = { manutencaoGeral:0, pinturaTeto:0, outrosServicos:0 };
    monthMap[ym][categorizarServicoManutencao(r.servico)] += r.v;
  });
  const keys = Object.keys(monthMap).sort();
  m.labels = keys.map(k=>{ const [y,mm] = k.split("-"); return MONTH_ABBR[parseInt(mm,10)-1] + "/" + y.slice(2); });
  m.manutencaoGeral = keys.map(k=>Math.round(monthMap[k].manutencaoGeral));
  m.pinturaTeto = keys.map(k=>Math.round(monthMap[k].pinturaTeto));
  m.outrosServicos = keys.map(k=>Math.round(monthMap[k].outrosServicos));
  recomputeManutencao();
}

// Histórico de lançamentos feitos por aqui (feedback visual + permite excluir um lançamento errado).
// Fica salvo no localStorage deste navegador, então sobrevive a um F5 — some só se você limpar os
// dados do site ou trocar de navegador/computador.
const SESSION_LOG_KEY = "avanceBI_sessionLog";
const sessionLog = [];
let sessionLogSeq = 0;
function salvarSessionLogLocal(){
  try{ localStorage.setItem(SESSION_LOG_KEY, JSON.stringify(sessionLog)); }
  catch(e){ console.warn("Não foi possível salvar o histórico de lançamentos neste navegador:", e); }
}
function carregarSessionLogLocal(){
  try{
    const raw = localStorage.getItem(SESSION_LOG_KEY);
    if(!raw) return;
    const salvos = JSON.parse(raw);
    if(Array.isArray(salvos)){
      sessionLog.push(...salvos);
      sessionLogSeq = salvos.reduce((m,l)=>Math.max(m, l.id||0), 0);
    }
  }catch(e){ console.warn("Não foi possível carregar o histórico de lançamentos salvo:", e); }
}
function logEntry(modulo, descricao, undo){
  sessionLog.unshift({ id: ++sessionLogSeq, hora:new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}), modulo, descricao, undo });
  if(sessionLog.length > 30) sessionLog.pop();
  salvarSessionLogLocal();
}
// Chamado pelo botão "Excluir" na tabela de "Lançamentos desta sessão": desfaz o lançamento
// (restaura o valor anterior, ou remove o período/linha se era novo) local e no banco.
window.deleteSessionEntry = async (id) => {
  const idx = sessionLog.findIndex(l=>l.id===id);
  if(idx===-1) return;
  const entry = sessionLog[idx];
  if(!confirm(`Excluir este lançamento?\n\n${entry.modulo} · ${entry.descricao}`)) return;
  if(entry.undo){
    try{ await executarUndo(entry.undo); }
    catch(e){ toast("⚠ Falha ao excluir: " + e.message); return; }
  }
  sessionLog.splice(idx,1);
  salvarSessionLogLocal();
  renderSessionLog();
  const activePage = document.querySelector('nav.menu button.active')?.dataset.page;
  if(activePage) navigate(activePage);
  toast("Lançamento excluído ✓");
};
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
        c = DATA.compras, at = DATA.atestados, inf = DATA.infracoes, ac = DATA.acidentes, cp = DATA.contasPagar;

  const cpPendente = sumArr(cp.lancamentos.filter(i=>i.status!=="Pago").map(i=>i.valor));
  const cpVencidas = cp.lancamentos.filter(i=>statusConta(i)==="Vencido").length;

  const cards = [
    { page:"manutencao", ic:"🔩", label:"Manutenção de Carreta", big:fmtBRL(m.totalPeriodo), foot:"Total acumulado dez/25–jun/26", id:"spk-manutencao" },
    { page:"diesel", ic:"⛽", label:"Diesel (2026)", big:fmtBRL(d.totalAno2026), foot:"Média semanal " + fmtMil(d.mediaSemanal), id:"spk-diesel" },
    { page:"folha", ic:"💰", label:"Folha · Salário (2026)", big:f.totalSalario2026_M.toFixed(3).replace(".",",") + " Mi", foot:`+${f.crescimentoPct}% vs. 2025 (5 meses)`, id:"spk-folha" },
    { page:"horaextra", ic:"⏱️", label:"Hora Extra (jan–jun/26)", big:fmtBRL(he.janJun2026), foot:`+${he.crescimentoPct}% vs. mesmo período 2025`, id:"spk-he" },
    { page:"compras", ic:"🧰", label:"Compras de Peças (2026)", big:fmtBRL(c.totalAno2026), foot:`Top 10 veículos = ${c.top10CaminhoesPct}%`, id:"spk-compras" },
    { page:"atestados", ic:"🩺", label:"Atestados (mai/26)", big:fmtNum(at.ocorrencias[at.ocorrencias.length-1]), foot:"Ocorrências no último mês fechado", id:"spk-atestados" },
    { page:"infracoes", ic:"🚨", label:"Infrações (2026)", big:fmtNum(inf.totalAno2026), foot:`Uso de celular: ${inf.usoCelular2026} ocorrências`, id:"spk-infracoes" },
    { page:"acidentes", ic:"⚠️", label:"Acidentes & Incidentes", big:"0", foot:"Nenhuma ocorrência registrada em 2025", id:"spk-acidentes" },
    { page:"contaspagar", ic:"💵", label:"Contas a Pagar", big:fmtBRL(cpPendente), foot: cpVencidas>0 ? `⚠ ${cpVencidas} conta(s) vencida(s)` : "Nenhuma conta vencida" }
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
          ${c.id ? `<canvas id="${c.id}" height="36"></canvas>` : ""}
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
    <div class="page-head"><h2>Manutenção de Carreta</h2><p>Custo em R$ por tipo de serviço, ${m.labels[0]} a ${m.labels[m.labels.length-1]}</p></div>
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

/* -------------------- CONTAS A PAGAR -------------------- */
renderers.contaspagar = () => {
  const cp = DATA.contasPagar;
  const itens = [...cp.lancamentos].sort((a,b)=> a.dataVencimento.localeCompare(b.dataVencimento));
  const totalPendente = sumArr(itens.filter(i=>i.status!=="Pago").map(i=>i.valor));
  const totalPago = sumArr(itens.filter(i=>i.status==="Pago").map(i=>i.valor));
  const vencidas = itens.filter(i=>statusConta(i)==="Vencido");
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const em7dias = new Date(hoje.getTime()+7*86400000);
  const venc7 = itens.filter(i=>{
    if(i.status==="Pago") return false;
    const v = new Date(i.dataVencimento+"T00:00:00");
    return v>=hoje && v<=em7dias;
  });

  const porTipo = {};
  itens.forEach(i=>{ porTipo[i.tipoServico] = (porTipo[i.tipoServico]||0) + i.valor; });
  const porTipoArr = Object.entries(porTipo).sort((a,b)=>b[1]-a[1]);

  const porPrestador = {};
  itens.forEach(i=>{ porPrestador[i.prestador] = (porPrestador[i.prestador]||0) + i.valor; });
  const topPrestadores = Object.entries(porPrestador).sort((a,b)=>b[1]-a[1]).slice(0,10);

  return `
    <div class="page-head"><h2>Contas a Pagar</h2><p>Prestadores de serviço — controle de vencimentos e status de pagamento</p></div>
    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Total pendente</div><div class="val">${fmtBRL(totalPendente)}</div><div class="delta flat">${itens.filter(i=>i.status!=="Pago").length} conta(s) em aberto</div></div>
      <div class="kpi"><div class="lbl">Vencidas</div><div class="val">${vencidas.length}</div>${vencidas.length>0?`<span class="delta up">↑ ${fmtBRL(sumArr(vencidas.map(i=>i.valor)))}</span>`:`<span class="delta down">↓ nenhuma</span>`}</div>
      <div class="kpi"><div class="lbl">Vencendo em 7 dias</div><div class="val">${venc7.length}</div><div class="delta flat">${fmtBRL(sumArr(venc7.map(i=>i.valor)))}</div></div>
      <div class="kpi"><div class="lbl">Total já pago</div><div class="val">${fmtBRL(totalPago)}</div></div>
    </div>

    <div class="grid-2">
      <div class="panel">
        <h3>Custo por tipo de serviço</h3>
        <div class="chart-wrap" style="height:260px;"><canvas id="ch-cp-tipo"></canvas></div>
      </div>
      <div class="panel">
        <h3>Maiores prestadores</h3>
        <table>
          <thead><tr><th>#</th><th>Prestador</th><th class="num">Valor</th></tr></thead>
          <tbody>${topPrestadores.map(([nome,v],i)=>`<tr><td class="rank">${i+1}</td><td>${nome}</td><td class="num">${fmtBRL2(v)}</td></tr>`).join("")}</tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <h3>Todas as contas</h3>
      <div class="hint">Ordenadas por vencimento — clique em "Marcar como pago" para dar baixa</div>
      <table>
        <thead><tr><th>Status</th><th>Prestador</th><th>Tipo de Serviço</th><th>CNPJ</th><th>Forma Pgto</th><th class="num">Valor</th><th>Vencimento</th><th>Ação</th></tr></thead>
        <tbody>
          ${itens.map(i=>{
            const st = statusConta(i);
            return `<tr>
              <td><span class="badge ${statusBadgeClass(st)}">${st}</span></td>
              <td>${i.prestador}</td>
              <td>${i.tipoServico}</td>
              <td>${i.cnpj}</td>
              <td>${i.formaPagamento}</td>
              <td class="num">${fmtBRL2(i.valor)}</td>
              <td>${fmtDataBR(i.dataVencimento)}</td>
              <td>${i.status==="Pago" ? `<span class="hint" style="margin:0;">pago em ${fmtDataBR(i.dataPagamento)}</span>` : `<button onclick="marcarContaPaga('${i.id}')" style="background:var(--green); color:#fff; border:none; padding:5px 10px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer;">Marcar como pago</button>`}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
};
initCharts.contaspagar = () => {
  const cp = DATA.contasPagar;
  const porTipo = {};
  cp.lancamentos.forEach(i=>{ porTipo[i.tipoServico] = (porTipo[i.tipoServico]||0) + i.valor; });
  const arr = Object.entries(porTipo).sort((a,b)=>b[1]-a[1]);
  mkChart("ch-cp-tipo", {
    type:"bar",
    data:{ labels:arr.map(a=>a[0]), datasets:[{ data:arr.map(a=>a[1]), backgroundColor:COLORS.red, borderRadius:4 }]},
    options:{ indexAxis:"y", responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
        datalabels:{ display:true, anchor:"end", align:"right", color:COLORS.ink, font:{size:10, weight:700}, formatter:fmtLabelBRL } },
      layout:{ padding:{ right:46 } },
      scales:{ x:{grid:{color:COLORS.grid}, ticks:{callback:v=>fmtMil(v)}}, y:{grid:{display:false}} } }
  });
};
window.marcarContaPaga = async (id) => {
  const item = DATA.contasPagar.lancamentos.find(i=>i.id===id);
  if(!item) return;
  item.status = "Pago";
  item.dataPagamento = new Date().toISOString().slice(0,10);
  navigate("contaspagar");
  if(sb){
    const { error } = await sb.from("contas_pagar").update({ status:"Pago", data_pagamento:item.dataPagamento }).eq("id", id);
    if(error){ toast("⚠ Salvo aqui, mas falhou ao gravar no banco: " + error.message); return; }
  }
  toast(`✓ Conta de ${item.prestador} marcada como paga`);
};

window.rodarMigracaoSupabase = async () => {
  const statusEl = document.getElementById("migracaoStatus");
  try{
    await migrarParaSupabase((msg)=>{ if(statusEl) statusEl.textContent = msg; });
    updateSyncPill();
    toast("✓ Migração para o Supabase concluída");
    navigate("entrada");
  }catch(e){
    console.error(e);
    if(statusEl) statusEl.textContent = "⚠ Erro na migração: " + e.message;
    toast("⚠ Erro ao migrar — veja detalhes na tela");
  }
};

/* -------------------- ENTRADA DE DADOS -------------------- */
const ENTRY_MODULES = [
  { key:"contaspagar", ic:"💵", label:"Contas a Pagar", desc:"Prestador de serviço, CNPJ, valor, forma de pagamento e vencimento" },
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
const MANUTENCAO_SERVICOS = ["Manutenção Geral","Pintura do Teto","Outros Serviços"];
const TIPOS_SERVICO = ["Manutenção e Reparação","Frete / Transporte","Consultoria","Jurídico","Contábil","TI / Software","Limpeza","Segurança","Combustível","Locação de Equipamento","Outros"];
const FORMAS_PAGAMENTO = ["Boleto","PIX","Transferência (TED/DOC)","Cartão","Dinheiro"];

renderers.entrada = () => `
  <div class="page-head"><h2>Entrada de Dados</h2><p>Escolha a categoria, informe o período e o valor. Os gráficos e KPIs recalculam na hora.</p></div>

  ${!sb ? `
  <div class="panel" style="margin-bottom:16px; border-color:#F0B9C0; background:var(--red-soft);">
    <h3 style="margin-bottom:4px;">⚠ Sem conexão com o banco</h3>
    <div class="hint" style="margin-bottom:0;">Confira se o arquivo <code>supabase-config.js</code> está na mesma pasta e se a URL/chave estão corretas. Por enquanto os lançamentos ficam só nesta aba (use "Baixar data.js atualizado" para não perder).</div>
  </div>` : !SUPABASE_SINCRONIZADO ? `
  <div class="panel" style="margin-bottom:16px; border-color:#F0B9C0; background:var(--red-soft);">
    <h3 style="margin-bottom:4px;">📤 Banco vazio — migre os dados atuais uma única vez</h3>
    <div class="hint" style="margin-bottom:10px;">Isso envia tudo que já está carregado (compras, manutenção, folha, contas a pagar, etc.) para o Supabase. Faça isso só uma vez — depois disso todo mundo que abrir o link já vê os dados do banco, e novos lançamentos vão direto pra lá.</div>
    <button onclick="rodarMigracaoSupabase()" style="background:var(--red); color:#fff; border:none; padding:11px 20px; border-radius:9px; font-size:13px; font-weight:700; cursor:pointer;">Migrar dados para o Supabase</button>
    <div id="migracaoStatus" class="hint" style="margin-top:10px;"></div>
  </div>` : `
  <div class="panel" style="margin-bottom:16px; display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap;">
    <div>
      <h3 style="margin-bottom:4px;">✅ Conectado ao Supabase</h3>
      <div class="hint" style="margin-bottom:0;">Todo lançamento feito abaixo já é salvo direto no banco — quem abrir o link já vê a atualização, sem precisar de nada manual.</div>
    </div>
    <button onclick="exportDataJs()" style="background:var(--card); color:var(--ink); border:1px solid var(--line); padding:10px 16px; border-radius:9px; font-size:12.5px; font-weight:700; cursor:pointer; white-space:nowrap;">⬇ Backup local (data.js)</button>
  </div>`}

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
      <div class="hint">Fica salvo neste navegador (sobrevive a recarregar a página) — clique em Excluir pra desfazer um lançamento errado</div>
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
  el.innerHTML = `<table><thead><tr><th>Hora</th><th>Módulo</th><th>Lançamento</th><th></th></tr></thead><tbody>
    ${sessionLog.map(l=>`<tr><td>${l.hora}</td><td>${l.modulo}</td><td>${l.descricao}</td><td style="text-align:right;">
      <button type="button" onclick="deleteSessionEntry(${l.id})" title="Excluir este lançamento"
        style="border:1px solid var(--line); background:#fff; color:var(--red); border-radius:6px; padding:4px 8px; font-size:12px; cursor:pointer;">
        🗑 Excluir
      </button>
    </td></tr>`).join("")}
  </tbody></table>`;
}

const ENTRY_FORMS = {
  contaspagar: () => `
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px;">
      <label style="grid-column:1/-1;">Prestador de Serviço<input type="text" id="ecp-prestador" list="dl-prestadores" placeholder="Ex: MANUTENÇÃO E REPARAÇÃO CB MECA"></label>
      <datalist id="dl-prestadores">${[...new Set(DATA.contasPagar.lancamentos.map(r=>r.prestador))].sort().map(l=>`<option value="${l}">`).join("")}</datalist>
      <label>CNPJ<input type="text" id="ecp-cnpj" placeholder="00.000.000/0000-00"></label>
      <label>Tipo de Serviço<input type="text" id="ecp-tipo" list="dl-tipos-servico" placeholder="Ex: Manutenção e Reparação"></label>
      <datalist id="dl-tipos-servico">${TIPOS_SERVICO.map(t=>`<option value="${t}">`).join("")}</datalist>
      <label>Valor do Serviço (R$)<input type="number" id="ecp-valor" step="0.01" placeholder="0,00"></label>
      <label>Forma de Pagamento<select id="ecp-forma">${FORMAS_PAGAMENTO.map(f=>`<option>${f}</option>`).join("")}</select></label>
      <label>Data de Emissão<input type="date" id="ecp-emissao" value="${new Date().toISOString().slice(0,10)}"></label>
      <label>Data de Vencimento<input type="date" id="ecp-vencimento"></label>
      <label style="grid-column:1/-1;">Nº do Documento (opcional)<input type="text" id="ecp-numdoc" placeholder="Ex: 0262"></label>
    </div>
    <button class="entry-submit" onclick="submitContaPagar()">Adicionar conta a pagar</button>
  `,
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
    <div style="background:var(--red-soft); border:1px solid #F0B9C0; border-radius:12px; padding:16px; margin-top:12px;">
      <h4 style="font-size:13px; margin-bottom:4px;">📤 Importar planilha (.xlsx)</h4>
      <div class="hint" style="margin-bottom:10px;">
        Lê só a aba <b>"Matriz"</b> da planilha (as outras abas são ignoradas). Colunas esperadas nela:
        DATA DO SERVIÇO, LOCAL, NF'S, O.S, FROTA, PLACA, VALOR R$, SERVIÇO, STATUS.<br>
        <b>Importar substitui todo o histórico de Manutenção de Carreta do sistema pelo conteúdo da aba Matriz</b>
        (os totais mensais do dashboard passam a vir só dos lançamentos importados).
      </div>
      <input type="file" id="em-import-file" accept=".xlsx,.xls,.csv" style="font-size:12.5px;">
      <button class="entry-submit" style="margin-top:10px;" onclick="importManutencaoXlsx()">Importar e substituir</button>
      <div id="em-import-status" class="hint" style="margin-top:10px;"></div>
    </div>
    <hr style="margin:20px 0; border:none; border-top:1px solid var(--line);">
    <div class="hint" style="margin-bottom:4px;">Ou lance um serviço avulso manualmente:</div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px;">
      <label>Data<input type="date" id="em-data" value="${new Date().toISOString().slice(0,10)}"></label>
      <label>Placa / Frota<input type="text" id="em-placa" placeholder="Ex: DPB-3917"></label>
      <label style="grid-column:1/-1;">Local / Oficina (opcional)<input type="text" id="em-local" list="dl-manut-locais" placeholder="Ex: Oficina Central"></label>
      <datalist id="dl-manut-locais">${[...new Set(DATA.manutencao.lancamentos.map(r=>r.local).filter(Boolean))].sort().map(l=>`<option value="${l}">`).join("")}</datalist>
      <label>Tipo de Serviço<select id="em-servico">${MANUTENCAO_SERVICOS.map(s=>`<option>${s}</option>`).join("")}</select></label>
      <label>Valor (R$)<input type="number" id="em-valor" step="0.01" placeholder="0,00"></label>
    </div>
    <button class="entry-submit" onclick="submitManutencao()">Adicionar lançamento</button>
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

    const anteriores = DATA.compras.comprasLancamentos;
    DATA.compras.comprasLancamentos = novos;
    deriveCompras();
    logEntry("Compras (importação)", `${novos.length} lançamentos importados de "${file.name}"`, { kind:"bulkImportCompras", anteriores });
    renderSessionLog();

    const datas = novos.map(r=>r.d).sort();
    let statusMsg = `✓ <b>${fmtNum(novos.length)}</b> lançamentos importados (${datas[0].split("-").reverse().join("/")} a ${datas[datas.length-1].split("-").reverse().join("/")}), total ${fmtBRL(novos.reduce((s,r)=>s+r.v,0))}.` +
      (manutCount>0 ? `<br>${manutCount} linhas com placa "MANUTENÇÃO" (${fmtBRL(manutSoma)}) foram ignoradas — pertencem ao módulo de Manutenção de Carreta, não a Compras de Peças.` : "") +
      (ignoradas>0 ? `<br>${ignoradas} linha(s) sem data ou valor válido foram ignoradas.` : "");
    statusEl.innerHTML = statusMsg;

    if(document.querySelector('nav.menu button.active')?.dataset.page === "compras") navigate("compras");

    if(sb){
      statusEl.innerHTML = statusMsg + "<br>Substituindo no banco de dados...";
      const { error: delError } = await sb.from("compras_lancamentos").delete().not("id","is",null);
      if(delError){ statusEl.innerHTML = statusMsg + "<br>⚠ Salvo aqui, mas falhou ao limpar o banco: " + delError.message; return; }
      try{
        await sbBulkInsert("compras_lancamentos", novos.map(r=>({ data:r.d, placa:r.p, local:r.l, categoria:r.c, item:r.i, valor:r.v })));
        statusEl.innerHTML = statusMsg + "<br>✓ Banco de dados atualizado — todo mundo que abrir o link já vê essa importação.";
        toast(`✓ ${novos.length} lançamentos importados (salvo no banco)`);
      }catch(e){
        statusEl.innerHTML = statusMsg + "<br>⚠ Salvo aqui, mas falhou ao gravar no banco: " + e.message;
      }
    } else {
      toast(`✓ ${novos.length} lançamentos importados`);
    }
  }catch(e){
    console.error(e);
    statusEl.textContent = "⚠ Erro ao ler o arquivo: " + e.message;
  }
};

// Converte "R$ 1.240,00" (ou já número) pro formato numérico usado internamente.
function parseValorBRL(v){
  if(typeof v === "number") return v;
  if(v == null) return NaN;
  return parseFloat(String(v).replace(/[R$\s.]/g,"").replace(",","."));
}

window.importManutencaoXlsx = async () => {
  const fileInput = document.getElementById("em-import-file");
  const statusEl = document.getElementById("em-import-status");
  const file = fileInput.files[0];
  if(!file){ statusEl.textContent = "⚠ Selecione um arquivo primeiro."; return; }
  if(typeof XLSX === "undefined"){ statusEl.textContent = "⚠ Biblioteca de planilhas não carregada (confira se xlsx.full.min.js está na pasta)."; return; }

  statusEl.textContent = "Lendo planilha...";
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type:"array", cellDates:true });

    // O relatório vem com várias abas (semanas soltas, rascunhos etc.), mas só a aba "Matriz" é a
    // consolidada que deve ser importada — as outras são ignoradas de propósito.
    const nomeAbaAlvo = wb.SheetNames.find(n=>n.trim().toUpperCase()==="MATRIZ");
    if(!nomeAbaAlvo){
      statusEl.textContent = `⚠ Não encontrei uma aba chamada "Matriz" nesta planilha. Abas encontradas: ${wb.SheetNames.join(", ")}.`;
      return;
    }

    const rows = XLSX.utils.sheet_to_json(wb.Sheets[nomeAbaAlvo], { header:1, defval:null });
    let headerRow = null, sheetRows = null;
    for(let i=0;i<Math.min(rows.length,30);i++){
      const r = rows[i];
      if(r && r.some(c=>c!=null && String(c).trim().toUpperCase()==="DATA DO SERVIÇO")){
        headerRow = r; sheetRows = rows.slice(i+1); break;
      }
    }
    if(!headerRow){
      statusEl.textContent = "⚠ Não encontrei a linha de cabeçalho (esperava uma coluna 'Data do Serviço') na aba Matriz. Confira se é a mesma estrutura do seu relatório semanal.";
      return;
    }

    const idx = {};
    headerRow.forEach((h,i)=>{ if(h!=null) idx[String(h).trim().toUpperCase()] = i; });
    const col = (colName) => idx[colName];
    const cData = col("DATA DO SERVIÇO"), cLocal = col("LOCAL"), cNf = col("NF'S") ?? col("NF"),
          cOs = col("O.S") ?? col("O.S."), cFrota = col("FROTA"), cPlaca = col("PLACA"),
          cValor = col("VALOR R$") ?? col("VALOR"), cServico = col("SERVIÇO"), cStatus = col("STATUS");
    if(cData==null || cValor==null){
      statusEl.textContent = "⚠ Faltam colunas essenciais (DATA DO SERVIÇO ou VALOR R$) na aba Matriz. Confira o cabeçalho da planilha.";
      return;
    }

    const novos = [];
    let ignoradas = 0;
    sheetRows.forEach(r=>{
      if(!r) return;
      const dataRaw = r[cData], valorRaw = r[cValor];
      if(dataRaw == null || valorRaw == null || valorRaw === "") { ignoradas++; return; }
      const iso = excelDateToISO(dataRaw);
      if(!iso){ ignoradas++; return; }
      const valor = parseValorBRL(valorRaw);
      if(isNaN(valor)){ ignoradas++; return; }
      novos.push({
        id: localId(),
        d: iso,
        placa: (cPlaca!=null ? (r[cPlaca]||"").toString().trim() : ""),
        local: (cLocal!=null ? (r[cLocal]||"").toString().trim() : "") || "Não informado",
        nf: (cNf!=null ? (r[cNf]||"").toString().trim() : ""),
        os: (cOs!=null ? (r[cOs]||"").toString().trim() : ""),
        frota: (cFrota!=null ? (r[cFrota]||"").toString().trim() : ""),
        servico: (cServico!=null ? (r[cServico]||"").toString().trim() : "") || "Outros Serviços",
        status: (cStatus!=null ? (r[cStatus]||"").toString().trim() : ""),
        v: valor
      });
    });

    if(novos.length === 0){
      statusEl.textContent = "⚠ Nenhum lançamento válido encontrado na planilha.";
      return;
    }

    const anteriores = DATA.manutencao.lancamentos;
    DATA.manutencao.lancamentos = novos;
    deriveManutencao();
    logEntry("Manutenção (importação)", `${novos.length} lançamentos importados de "${file.name}"`, { kind:"bulkImportManutencao", anteriores });
    renderSessionLog();

    const datas = novos.map(r=>r.d).sort();
    let statusMsg = `✓ <b>${fmtNum(novos.length)}</b> lançamentos importados (${datas[0].split("-").reverse().join("/")} a ${datas[datas.length-1].split("-").reverse().join("/")}), total ${fmtBRL(novos.reduce((s,r)=>s+r.v,0))}.` +
      (ignoradas>0 ? `<br>${ignoradas} linha(s) sem data ou valor válido foram ignoradas.` : "");
    statusEl.innerHTML = statusMsg;

    if(document.querySelector('nav.menu button.active')?.dataset.page === "manutencao") navigate("manutencao");

    if(sb){
      statusEl.innerHTML = statusMsg + "<br>Substituindo no banco de dados...";
      const { error: delError } = await sb.from("manutencao_lancamentos").delete().not("id","is",null);
      if(delError){ statusEl.innerHTML = statusMsg + "<br>⚠ Salvo aqui, mas falhou ao limpar o banco: " + delError.message; return; }
      try{
        await sbBulkInsert("manutencao_lancamentos", novos.map(r=>({ data:r.d, placa:r.placa, local:r.local, nf:r.nf, os:r.os, frota:r.frota, servico:r.servico, status:r.status, valor:r.v })));
        statusEl.innerHTML = statusMsg + "<br>✓ Banco de dados atualizado — todo mundo que abrir o link já vê essa importação.";
        toast(`✓ ${novos.length} lançamentos importados (salvo no banco)`);
      }catch(e){
        statusEl.innerHTML = statusMsg + "<br>⚠ Salvo aqui, mas falhou ao gravar no banco: " + e.message;
      }
    } else {
      toast(`✓ ${novos.length} lançamentos importados`);
    }
  }catch(e){
    console.error(e);
    statusEl.textContent = "⚠ Erro ao ler o arquivo: " + e.message;
  }
};

window.submitContaPagar = async () => {
  const prestador = document.getElementById("ecp-prestador").value.trim();
  const cnpj = document.getElementById("ecp-cnpj").value.trim();
  const tipo = document.getElementById("ecp-tipo").value.trim();
  const valor = parseFloat(document.getElementById("ecp-valor").value);
  const forma = document.getElementById("ecp-forma").value;
  const emissao = document.getElementById("ecp-emissao").value;
  const vencimento = document.getElementById("ecp-vencimento").value;
  const numdoc = document.getElementById("ecp-numdoc").value.trim();

  if(!prestador || isNaN(valor) || !vencimento){ toast("Preencha ao menos prestador, valor e vencimento."); return; }

  const novaConta = {
    id: localId(), prestador, cnpj, tipoServico: tipo || "Outros", valor, formaPagamento: forma,
    dataEmissao: emissao || null, dataVencimento: vencimento, numeroDocumento: numdoc || null,
    status: "Pendente", dataPagamento: null
  };
  DATA.contasPagar.lancamentos.push(novaConta);
  const undoDescr = prepararDesfazerArrayById("contasPagar.lancamentos", novaConta.id, "contas_pagar");
  logEntry("Contas a Pagar", `${prestador} · ${fmtBRL2(valor)} · vence ${vencimento.split("-").reverse().join("/")}`, undoDescr);
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "contaspagar") navigate("contaspagar");

  if(sb){
    const { data, error } = await sb.from("contas_pagar").insert({
      prestador, cnpj, tipo_servico: tipo || "Outros", valor, forma_pagamento: forma,
      data_emissao: emissao || null, data_vencimento: vencimento, numero_documento: numdoc || null, status: "Pendente"
    }).select().single();
    if(error){ toast("⚠ Salvo aqui, mas falhou ao gravar no banco: " + error.message); return; }
    novaConta.id = data.id; // troca o id local pelo id real do banco, pra "marcar como pago" funcionar depois
    undoDescr.itemId = data.id;
    undoDescr.sbId = data.id;
    salvarSessionLogLocal();
  }
  toast("Conta a pagar adicionada ✓" + (sb ? " (salvo no banco)" : ""));
};

window.submitCompra = async () => {
  const d = document.getElementById("ec-data").value;
  const v = parseFloat(document.getElementById("ec-valor").value);
  if(!d || isNaN(v)){ toast("Preencha data e valor."); return; }
  const placa = document.getElementById("ec-placa").value.trim();
  const local = document.getElementById("ec-local").value.trim()||"Não informado";
  const categoria = document.getElementById("ec-categoria").value;
  const item = document.getElementById("ec-item").value.trim()||"—";
  const registro = { id: localId(), d, p:placa, l:local, c:categoria, i:item, v };
  DATA.compras.comprasLancamentos.push(registro);
  deriveCompras();
  const undoDescr = prepararDesfazerArrayById("compras.comprasLancamentos", registro.id, "compras_lancamentos");
  logEntry("Compras de Peças", `${d.split("-").reverse().join("/")} · ${fmtBRL2(v)}`, undoDescr);
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "compras") navigate("compras");

  if(sb){
    const { data, error } = await sb.from("compras_lancamentos").insert({ data:d, placa, local, categoria, item, valor:v }).select().single();
    if(error){ toast("⚠ Salvo aqui, mas falhou ao gravar no banco: " + error.message); return; }
    registro.id = data.id;
    undoDescr.itemId = data.id;
    undoDescr.sbId = data.id;
    salvarSessionLogLocal();
  }
  toast("Compra adicionada ✓" + (sb ? " (salvo no banco)" : ""));
};

window.submitDiesel = async () => {
  const mensalOn = document.getElementById("diesel-mensal").style.display !== "none";
  let sbRow = null;
  if(mensalOn){
    const label = document.getElementById("ed-mes").value.trim();
    const v = parseFloat(document.getElementById("ed-valor").value);
    if(!label || isNaN(v)){ toast("Preencha mês e valor."); return; }
    sbRow = { modulo:"diesel_mensal", campo:"mensal", label, valor:v };
    const undo = prepararDesfazerPeriodo("diesel", "mensalLabels", label, ["mensal"], "recomputeDiesel", "series_periodo", [sbRow]);
    upsertPeriod(DATA.diesel, "mensalLabels", label, { mensal:v });
    recomputeDiesel();
    logEntry("Diesel (mensal)", `${label} · ${fmtBRL(v)}`, undo);
  } else {
    const label = document.getElementById("ed-semana").value.trim();
    const v = parseFloat(document.getElementById("ed-valorsem").value);
    if(!label || isNaN(v)){ toast("Preencha semana e valor."); return; }
    sbRow = { modulo:"diesel_semanal", campo:"semanal_x1000", label, valor:v };
    const undo = prepararDesfazerPeriodo("diesel", "semanalLabels", label, ["semanal_x1000"], "recomputeDiesel", "series_periodo", [sbRow]);
    upsertPeriod(DATA.diesel, "semanalLabels", label, { semanal_x1000:v });
    recomputeDiesel();
    logEntry("Diesel (semanal)", `${label} · ${v}K`, undo);
  }
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "diesel") navigate("diesel");
  await gravarSeriePeriodo(sbRow, "Diesel");
};

window.submitManutencao = async () => {
  const d = document.getElementById("em-data").value;
  const v = parseFloat(document.getElementById("em-valor").value);
  if(!d || isNaN(v)){ toast("Preencha data e valor."); return; }
  const placa = document.getElementById("em-placa").value.trim();
  const local = document.getElementById("em-local").value.trim() || "Não informado";
  const servico = document.getElementById("em-servico").value;
  const registro = { id: localId(), d, placa, local, nf:"", os:"", frota:"", servico, status:"", v };
  DATA.manutencao.lancamentos.push(registro);
  deriveManutencao();
  const undoDescr = prepararDesfazerArrayById("manutencao.lancamentos", registro.id, "manutencao_lancamentos");
  logEntry("Manutenção de Carreta", `${d.split("-").reverse().join("/")} · ${servico} · ${fmtBRL2(v)}`, undoDescr);
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "manutencao") navigate("manutencao");

  if(sb){
    const { data, error } = await sb.from("manutencao_lancamentos").insert({ data:d, placa, local, servico, valor:v }).select().single();
    if(error){ toast("⚠ Salvo aqui, mas falhou ao gravar no banco: " + error.message); return; }
    registro.id = data.id;
    undoDescr.itemId = data.id;
    undoDescr.sbId = data.id;
    salvarSessionLogLocal();
  }
  toast("Lançamento de manutenção adicionado ✓" + (sb ? " (salvo no banco)" : ""));
};

window.submitFolha = async () => {
  const label = document.getElementById("ef-mes").value.trim();
  const vt = parseFloat(document.getElementById("ef-vtvr").value) || 0;
  const ad = parseFloat(document.getElementById("ef-ad40").value) || 0;
  const sal = parseFloat(document.getElementById("ef-salario").value) || 0;
  if(!label){ toast("Informe o mês."); return; }
  const sbRows = [
    { modulo:"folha", campo:"vtVr", label, valor:vt },
    { modulo:"folha", campo:"ad40", label, valor:ad },
    { modulo:"folha", campo:"salario", label, valor:sal }
  ];
  const undo = prepararDesfazerPeriodo("folha", "labels", label, ["vtVr","ad40","salario"], "recomputeFolha", "series_periodo", sbRows);
  upsertPeriod(DATA.folha, "labels", label, { vtVr:vt, ad40:ad, salario:sal });
  recomputeFolha();
  logEntry("Folha", `${label} · total salário ${(ad+sal).toFixed(1)} mil`, undo);
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "folha") navigate("folha");
  await gravarSeriesPeriodo([
    { modulo:"folha", campo:"vtVr", label, valor:vt },
    { modulo:"folha", campo:"ad40", label, valor:ad },
    { modulo:"folha", campo:"salario", label, valor:sal }
  ], "Folha");
};

window.submitFolhaAnual = () => {
  const v25 = parseFloat(document.getElementById("ef-tot25").value);
  const v26 = parseFloat(document.getElementById("ef-tot26").value);
  const anterior25 = DATA.folha.totalSalario2025_M, anterior26 = DATA.folha.totalSalario2026_M;
  updateFolhaAnual(isNaN(v25)?null:v25, isNaN(v26)?null:v26);
  logEntry("Folha (totais anuais)", `2025: ${DATA.folha.totalSalario2025_M} Mi · 2026: ${DATA.folha.totalSalario2026_M} Mi`, { kind:"folhaAnual", anterior25, anterior26 });
  toast("Totais anuais atualizados ✓ (guardado só nesta aba — este KPI não é enviado ao banco)");
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "folha") navigate("folha");
};

window.submitHoraExtra = async () => {
  const ano = document.getElementById("eh-ano").value;
  const mes = document.getElementById("eh-mes").value;
  const idx = MONTH_ABBR.indexOf(mes);
  const custoOn = document.getElementById("he-custo").style.display !== "none";
  let sbRow = null;
  if(custoOn){
    const v = parseFloat(document.getElementById("eh-valor-custo").value);
    if(isNaN(v)){ toast("Informe o valor."); return; }
    const containerPath = `horaExtraCusto.${ano==="2025"?"y2025":"y2026"}`;
    sbRow = { modulo:`horaextra_custo_${ano}`, campo:"valor", label:mes, valor:v };
    const undo = prepararDesfazerIndice(containerPath, idx, "recomputeHoraExtraCusto", sbRow);
    getByPath(containerPath)[idx] = v;
    recomputeHoraExtraCusto();
    logEntry("Hora Extra (custo)", `${mes}/${ano} · ${fmtBRL(v)}`, undo);
  } else {
    const v = parseFloat(document.getElementById("eh-valor-qtd").value);
    if(isNaN(v)){ toast("Informe as horas."); return; }
    const containerPath = `horaExtraQtd.${ano==="2025"?"y2025":"y2026"}`;
    sbRow = { modulo:`horaextra_qtd_${ano}`, campo:"valor", label:mes, valor:v };
    const undo = prepararDesfazerIndice(containerPath, idx, "recomputeHoraExtraQtd", sbRow);
    getByPath(containerPath)[idx] = v;
    recomputeHoraExtraQtd();
    logEntry("Hora Extra (horas)", `${mes}/${ano} · ${v}h`, undo);
  }
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "horaextra") navigate("horaextra");
  await gravarSeriePeriodo(sbRow, "Hora Extra");
};

window.submitAtestado = async () => {
  const label = document.getElementById("ea-mes").value.trim();
  const v = parseInt(document.getElementById("ea-valor").value);
  if(!label || isNaN(v)){ toast("Preencha mês e ocorrências."); return; }
  const sbRow = { modulo:"atestados", campo:"ocorrencias", label, valor:v };
  const undo = prepararDesfazerPeriodo("atestados", "labels", label, ["ocorrencias"], null, "series_periodo", [sbRow]);
  upsertPeriod(DATA.atestados, "labels", label, { ocorrencias:v });
  logEntry("Atestados", `${label} · ${v} ocorrência(s)`, undo);
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "atestados") navigate("atestados");
  await gravarSeriePeriodo({ modulo:"atestados", campo:"ocorrencias", label, valor:v }, "Atestados");
};

window.submitInfracao = async () => {
  const mensalOn = document.getElementById("inf-mensal").style.display !== "none";
  if(mensalOn){
    const label = document.getElementById("ei-mes").value.trim();
    const v = parseInt(document.getElementById("ei-valor").value);
    if(!label || isNaN(v)){ toast("Preencha mês e ocorrências."); return; }
    const sbRow = { modulo:"infracoes", campo:"ocorrencias", label, valor:v };
    const undo = prepararDesfazerPeriodo("infracoes", "labels", label, ["ocorrencias"], "recomputeInfracoes", "series_periodo", [sbRow]);
    upsertPeriod(DATA.infracoes, "labels", label, { ocorrencias:v });
    recomputeInfracoes();
    logEntry("Infrações (mensal)", `${label} · ${v} ocorrência(s)`, undo);
    renderSessionLog();
    if(document.querySelector('nav.menu button.active')?.dataset.page === "infracoes") navigate("infracoes");
    await gravarSeriePeriodo({ modulo:"infracoes", campo:"ocorrencias", label, valor:v }, "Infrações");
  } else {
    const label = document.getElementById("ei-data").value.trim();
    const t1 = parseInt(document.getElementById("ei-turno1").value) || 0;
    const t2 = parseInt(document.getElementById("ei-turno2").value) || 0;
    if(!label){ toast("Informe a data."); return; }
    const sbRows = [
      { modulo:"infracoes_diario", campo:"turno1", label, valor:t1 },
      { modulo:"infracoes_diario", campo:"turno2", label, valor:t2 }
    ];
    const undo = prepararDesfazerPeriodo("infracoes.diario", "labels", label, ["turno1","turno2"], null, "eventos_diarios", sbRows);
    upsertPeriod(DATA.infracoes.diario, "labels", label, { turno1:t1, turno2:t2 });
    logEntry("Infrações (diário)", `${label} · T1:${t1} T2:${t2}`, undo);
    renderSessionLog();
    if(document.querySelector('nav.menu button.active')?.dataset.page === "infracoes") navigate("infracoes");
    await gravarEventosDiarios([
      { modulo:"infracoes_diario", campo:"turno1", label, valor:t1 },
      { modulo:"infracoes_diario", campo:"turno2", label, valor:t2 }
    ], "Infrações");
  }
};

window.submitAcidenteMes = async () => {
  const mes = document.getElementById("eac-mes").value;
  const v = parseInt(document.getElementById("eac-valor").value);
  if(isNaN(v)){ toast("Informe a quantidade."); return; }
  const idx = DATA.acidentes.labels.indexOf(mes);
  if(idx>=0){
    const sbRow = { modulo:"acidentes", campo:"valores", label:mes, valor:v };
    const undo = prepararDesfazerIndice("acidentes.valores", idx, null, sbRow);
    DATA.acidentes.valores[idx] = v;
    logEntry("Acidentes", `${mes} · ${v} ocorrência(s)`, undo);
  } else {
    logEntry("Acidentes", `${mes} · ${v} ocorrência(s)`);
  }
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "acidentes") navigate("acidentes");
  await gravarSeriePeriodo({ modulo:"acidentes", campo:"valores", label:mes, valor:v }, "Acidentes");
};
window.submitAcidenteAcao = async () => {
  const problema = document.getElementById("eac-problema").value.trim();
  const acao = document.getElementById("eac-acao").value.trim();
  const responsavel = document.getElementById("eac-resp").value.trim();
  if(!problema){ toast("Descreva o problema."); return; }
  const registro = { id: localId(), problema, acao, responsavel };
  DATA.acidentes.acoes.push(registro);
  const undoDescr = prepararDesfazerArrayById("acidentes.acoes", registro.id, "acidentes_acoes");
  logEntry("Acidentes (plano de ação)", problema, undoDescr);
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "acidentes") navigate("acidentes");
  if(sb){
    const { data, error } = await sb.from("acidentes_acoes").insert({ problema, acao, responsavel }).select().single();
    if(error){ toast("⚠ Salvo aqui, mas falhou ao gravar no banco: " + error.message); return; }
    registro.id = data.id;
    undoDescr.itemId = data.id;
    undoDescr.sbId = data.id;
    salvarSessionLogLocal();
  }
  toast("Ação adicionada ✓" + (sb ? " (salvo no banco)" : ""));
};

// Helpers usados pelos submits acima pra gravar no Supabase com upsert (não duplica se lançar o mesmo período de novo)
async function gravarSeriePeriodo(row, nomeModulo){
  return gravarSeriesPeriodo([row], nomeModulo);
}
async function gravarSeriesPeriodo(rows, nomeModulo){
  if(!sb){ toast(`${nomeModulo} atualizado ✓ (modo local)`); return; }
  const { error } = await sb.from("series_periodo").upsert(rows, { onConflict: "modulo,campo,label" });
  if(error){ toast("⚠ Salvo aqui, mas falhou ao gravar no banco: " + error.message); return; }
  toast(`${nomeModulo} atualizado ✓ (salvo no banco)`);
}
async function gravarEventosDiarios(rows, nomeModulo){
  if(!sb){ toast(`${nomeModulo} atualizado ✓ (modo local)`); return; }
  const { error } = await sb.from("eventos_diarios").upsert(rows, { onConflict: "modulo,campo,label" });
  if(error){ toast("⚠ Salvo aqui, mas falhou ao gravar no banco: " + error.message); return; }
  toast(`${nomeModulo} atualizado ✓ (salvo no banco)`);
}

initCharts.entrada = () => {
  mountEntryForm(ENTRY_MODULES[0].key);
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
function updateSyncPill(){
  const el = document.getElementById("syncPill");
  if(!el) return;
  if(!sb){
    el.innerHTML = `<span class="dot" style="background:var(--inkSoft);"></span> Modo local (sem banco configurado)`;
  } else if(SUPABASE_SINCRONIZADO){
    el.innerHTML = `<span class="dot"></span> Conectado ao banco`;
  } else {
    el.innerHTML = `<span class="dot" style="background:var(--amber);"></span> Banco vazio — vá em Entrada de Dados para migrar`;
  }
}

(async function initApp(){
  deriveCompras(); // garante que os dados locais (data.js) já estão prontos como base/fallback
  deriveManutencao();
  const carregouDoBanco = await loadFromSupabase();
  SUPABASE_SINCRONIZADO = carregouDoBanco;
  carregarSessionLogLocal();
  updateSyncPill();
  navigate("overview");
})();
