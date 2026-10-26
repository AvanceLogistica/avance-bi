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
let SUPABASE_FALHA_CONEXAO = false; // true quando uma busca no banco falhou por conexão (projeto pausado, sem internet...), não porque a tabela está genuinamente vazia

async function sbFetchAll(table){
  if(!sb) return [];
  let all = [], from = 0;
  const pageSize = 1000;
  while(true){
    const { data, error } = await sb.from(table).select("*").range(from, from + pageSize - 1);
    // Erro aqui quase sempre é falha de conexão (projeto Supabase pausado, sem internet, etc.), não
    // "a tabela existe mas está vazia" — guarda isso separado pra updateSyncPill() não confundir os
    // dois casos e dizer "banco vazio" quando na real os dados estão lá, só não deu pra buscar.
    // Exceção: "essa tabela não existe" é pendência de instalação (um script SQL que nunca foi
    // rodado), não queda de conexão — tratar como queda deixava o aviso vermelho aceso pra sempre.
    if(error){
      console.warn("Erro ao buscar", table, error);
      const tabelaInexistente = error.code === "PGRST205" || error.code === "42P01" ||
        /does not exist|schema cache/i.test(error.message || "");
      if(!tabelaInexistente) SUPABASE_FALHA_CONEXAO = true;
      break;
    }
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

// Aviso grande e vermelho de "não salvou no banco". Antes essa falha aparecia como uma linha de texto
// cinza no rodapé da caixa de importação e passava batida — a pessoa via os dados na tela, achava que
// tinha dado certo, e só descobria que não tinha salvo ao recarregar a página e ver tudo "sumir".
function avisoFalhaGravacao(e){
  return `<br><b style="color:var(--red-dark);">⚠ ATENÇÃO: a importação NÃO foi salva no banco de dados.</b>` +
    `<br>Os números aparecem na tela agora, mas somem quando você recarregar a página. O histórico que já estava no banco continua intacto.` +
    `<br>Motivo técnico: ${e && e.message ? e.message : e}`;
}

// Troca TODO o conteúdo de uma tabela pelo conteúdo novo de uma importação, na ordem segura:
// grava o novo PRIMEIRO e só depois apaga o antigo. A ordem importa muito — do jeito anterior
// (apagar tudo e depois inserir), qualquer falha no meio da inserção deixava a tabela vazia e o
// histórico era perdido de vez. Assim, se a inserção falhar, o dado antigo continua intacto e a
// importação inteira é abortada com erro; no pior caso (falha só ao limpar o antigo) sobram linhas
// duplicadas, que dá pra resolver reimportando — nunca perda de dados.
async function sbSubstituirTabela(table, rows){
  const antigos = await sbFetchAll(table);
  await sbBulkInsert(table, rows); // se falhar aqui, lança e o antigo segue no lugar
  const idsAntigos = antigos.map(r=>r.id).filter(Boolean);
  const chunkSize = 200; // ids vão na URL do DELETE, então não dá pra mandar milhares de uma vez
  for(let i=0;i<idsAntigos.length;i+=chunkSize){
    const { error } = await sb.from(table).delete().in("id", idsAntigos.slice(i, i+chunkSize));
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
  SUPABASE_FALHA_CONEXAO = false; // reseta a cada tentativa — só fica true se alguma busca desta rodada falhar
  try{
    const [compras, contas, series, diarios, acoes, manutLanc, dieselLanc, infLanc, entLanc, ftLanc, belemLanc, belemRec, atestLanc, heLancDb] = await Promise.all([
      sbFetchAll("compras_lancamentos"),
      sbFetchAll("contas_pagar"),
      sbFetchAll("series_periodo"),
      sbFetchAll("eventos_diarios"),
      sbFetchAll("acidentes_acoes"),
      sbFetchAll("manutencao_lancamentos"),
      sbFetchAll("diesel_abastecimentos"),
      sbFetchAll("infracoes_lancamentos"),
      sbFetchAll("entregas_lancamentos"),
      sbFetchAll("faturamento_lancamentos"),
      sbFetchAll("belem_lancamentos"),
      sbFetchAll("belem_receita"),
      sbFetchAll("atestados_lancamentos"),
      sbFetchAll("horaextra_lancamentos")
    ]);

    if(!compras.length && !contas.length && !series.length && !infLanc.length && !entLanc.length && !ftLanc.length && !belemLanc.length) return false; // banco ainda vazio

    if(compras.length){
      DATA.compras.comprasLancamentos = compras.map(r=>({ id:r.id, d:r.data, p:r.placa||"", l:r.local||"", c:r.categoria||"", i:r.item||"", v:Number(r.valor) }));
    }
    if(contas.length){
      DATA.contasPagar.lancamentos = contas.map(r=>({
        id:r.id, prestador:r.prestador, cnpj:r.cnpj, tipoServico:r.tipo_servico, servico:r.servico||null,
        parcela:r.parcela||null, valor:Number(r.valor), formaPagamento:r.forma_pagamento, dataEmissao:r.data_emissao,
        dataVencimento:r.data_vencimento, numeroDocumento:r.numero_documento, status:r.status, dataPagamento:r.data_pagamento
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
    if(dieselLanc.length){
      DATA.diesel.lancamentos = dieselLanc.map(r=>({
        id:r.id, d:r.data, placa:r.placa||"", km:r.km||null, litros:Number(r.litros)||0,
        valorUnit:r.valor_unitario!=null?Number(r.valor_unitario):null, motorista:r.motorista||"",
        posto:r.posto||"", status:r.status||"", v:Number(r.valor)
      }));
    }
    if(infLanc.length){
      DATA.infracoes.lancamentos = infLanc.map(r=>({
        id:r.id, d:r.data, motorista:r.motorista||"", placa:r.placa||"", turno:r.turno||"",
        hora:r.hora||"", ocorrencia:r.ocorrencia||"", observacoes:r.observacoes||""
      }));
    }
    if(entLanc.length){
      DATA.entregas.lancamentos = entLanc.map(r=>({
        id:r.id, d:r.data, servico:r.servico||"", transportadora:r.transportadora||"", cliente:r.cliente||"",
        motorista:r.motorista||"", carro:r.carro||"", qnt:Number(r.qnt)||1, v:Number(r.valor), observacao:r.observacao||""
      }));
    }
    if(ftLanc.length){
      DATA.faturamento.lancamentos = ftLanc.map(r=>({
        id:r.id, contrato:r.contrato||null, nf:r.nf||null, deadline:r.deadline||null, doc:r.doc||null,
        balsaViagem:r.balsa_viagem||null, valor:Number(r.valor), vencimento:r.vencimento||null
      }));
    }
    if(belemLanc.length){
      DATA.belem.lancamentos = belemLanc.map(r=>({
        id:r.id, d:r.data, categoria:r.categoria, descricao:r.descricao||"", referencia:r.referencia||"",
        qtd:r.quantidade!=null?Number(r.quantidade):null, v:Number(r.valor)
      }));
    }
    if(belemRec.length){
      DATA.belem.receita = {};
      belemRec.forEach(r=>{ DATA.belem.receita[r.mes] = Number(r.valor); });
    }
    if(atestLanc.length){
      DATA.atestados.lancamentos = atestLanc.map(r=>({
        id:r.id, d:r.data, colaborador:r.colaborador||"", motivo:r.motivo||"", categoria:r.categoria||"",
        horas:r.horas!=null?Number(r.horas):null, dias:r.dias!=null?Number(r.dias):0,
        dataRetorno:r.data_retorno||null, observacao:r.observacao||""
      }));
    }

    if(heLancDb.length){
      DATA.horaExtra.lancamentos = heLancDb.map(r=>({
        id:r.id, colaborador:r.colaborador||"", funcao:r.funcao||"", mes:String(r.mes).slice(0,7), total:Number(r.total)||0,
        he20:Number(r.he20)||0, he50:Number(r.he50)||0, he100:Number(r.he100)||0, dissidio:Number(r.dissidio)||0
      }));
      deriveHoraExtra();
    }

    deriveCompras();
    deriveManutencao();
    deriveDiesel();
    deriveInfracoes();
    deriveEntregas();
    return true;
  }catch(e){
    console.warn("Falha ao carregar do Supabase, mantendo dados locais:", e);
    SUPABASE_FALHA_CONEXAO = true;
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
    prestador:i.prestador, cnpj:i.cnpj, tipo_servico:i.tipoServico, servico:i.servico||null, parcela:i.parcela||null,
    valor:i.valor, forma_pagamento:i.formaPagamento, data_emissao:i.dataEmissao, data_vencimento:i.dataVencimento,
    numero_documento:i.numeroDocumento, status:i.status, data_pagamento:i.dataPagamento
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

  if(DATA.diesel.lancamentos.length){
    say(`Enviando ${fmtNum(DATA.diesel.lancamentos.length)} abastecimentos de Diesel...`);
    const dieselRows = DATA.diesel.lancamentos.map(r=>({ data:r.d, placa:r.placa, km:r.km, litros:r.litros, valor_unitario:r.valorUnit, valor:r.v, motorista:r.motorista, posto:r.posto, status:r.status }));
    await sbBulkInsert("diesel_abastecimentos", dieselRows);
  }

  if(DATA.infracoes.lancamentos.length){
    say(`Enviando ${fmtNum(DATA.infracoes.lancamentos.length)} ocorrências de Infrações...`);
    const infRows = DATA.infracoes.lancamentos.map(r=>({ data:r.d, motorista:r.motorista, placa:r.placa, turno:r.turno, hora:r.hora||null, ocorrencia:r.ocorrencia, observacoes:r.observacoes||null }));
    await sbBulkInsert("infracoes_lancamentos", infRows);
  }

  if(DATA.entregas.lancamentos.length){
    say(`Enviando ${fmtNum(DATA.entregas.lancamentos.length)} operações de Entregas...`);
    const entRows = DATA.entregas.lancamentos.map(r=>({ data:r.d, servico:r.servico, transportadora:r.transportadora, cliente:r.cliente, motorista:r.motorista, carro:r.carro, qnt:r.qnt, valor:r.v, observacao:r.observacao||null }));
    await sbBulkInsert("entregas_lancamentos", entRows);
  }

  if(DATA.faturamento.lancamentos.length){
    say(`Enviando ${fmtNum(DATA.faturamento.lancamentos.length)} lançamentos de Faturamento...`);
    const ftRows = DATA.faturamento.lancamentos.map(r=>({ contrato:r.contrato, nf:r.nf, deadline:r.deadline, doc:r.doc, balsa_viagem:r.balsaViagem, valor:r.valor, vencimento:r.vencimento }));
    await sbBulkInsert("faturamento_lancamentos", ftRows);
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

// Situação calculada de uma conta a pagar, sempre em cima da data de HOJE (não confia na coluna
// "Situação do Vencimento" importada da planilha, que é uma foto do dia em que ela foi exportada e
// fica desatualizada rápido): Pago (já quitada) / Vencido (passou do vencimento) / Vence na Semana
// (nos próximos 7 dias) / A Vencer (depois disso) / Sem vencimento (linha importada sem essa data).
function statusConta(c){
  if(c.status === "Pago") return "Pago";
  if(!c.dataVencimento) return "Sem vencimento";
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const venc = new Date(c.dataVencimento + "T00:00:00");
  if(venc < hoje) return "Vencido";
  const em7dias = new Date(hoje.getTime() + 7*86400000);
  return venc <= em7dias ? "Vence na Semana" : "A Vencer";
}
function statusBadgeClass(s){
  if(s === "Pago") return "green";
  if(s === "Vencido") return "red";
  if(s === "Vence na Semana") return "amber";
  return "gray"; // A Vencer / Sem vencimento
}
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

/* ============================================================================
   ANÁLISE AUTOMÁTICA — frases curtas (1-2 orações) exibidas abaixo de cada gráfico, recalculadas
   a cada render a partir dos dados já filtrados na tela. Três formatos cobrem praticamente todo
   gráfico do painel: série por período (insightSerie), ranking/top-N (insightRanking) e composição
   percentual (insightComposicao). "fmt" é sempre a função de formatação já usada no resto da página
   (fmtBRL, fmtNum, etc.) — pra frase sair no mesmo padrão dos KPIs.
   ============================================================================ */

// Série por período (mensal, semanal, diária...): destaca o pico e a variação do último ponto em
// relação ao anterior. skipZeros ignora pontos zerados/nulos ao escolher o pico (evita "pico" bobo
// quando quase tudo é zero, ex: Acidentes).
function insightSerie(labels, valores, fmt){
  const pares = labels.map((l,i)=>({ l, v: valores[i] })).filter(p=>p.v!=null);
  const comValor = pares.filter(p=>p.v>0);
  if(comValor.length === 0) return "Nenhuma ocorrência registrada no período.";
  const pico = comValor.reduce((a,b)=> b.v>a.v ? b : a);
  let frase = `Pico em ${pico.l}, com ${fmt(pico.v)}.`;
  if(pares.length >= 2){
    const ultimo = pares[pares.length-1], anterior = pares[pares.length-2];
    if(anterior.v){
      const variacao = (ultimo.v-anterior.v)/anterior.v*100;
      const dir = variacao >= 0 ? "alta" : "queda";
      frase += ` ${ultimo.l} teve ${dir} de ${Math.abs(variacao).toFixed(1)}% frente a ${anterior.l}.`;
    }
  }
  return frase;
}

// Ranking/top-N já ordenado do maior pro menor (fornecedores, motoristas, categorias...): destaca o
// líder e sua participação % sobre a soma de todos os itens (não só os exibidos no top, se "totalGeral"
// for passado — usado quando a lista já vem cortada em top 10/12 mas o total real é maior).
function insightRanking(items, nomeKey, valorKey, fmt, totalGeral){
  if(!items.length) return "Sem dados no período.";
  const total = totalGeral != null ? totalGeral : sumArr(items.map(i=>i[valorKey]));
  const lider = items[0];
  const pct = total ? (lider[valorKey]/total*100) : 0;
  return `${lider[nomeKey]} lidera com ${fmt(lider[valorKey])}${total ? ` (${pct.toFixed(0)}% do total)` : ""}.`;
}

// Composição percentual (doughnut/pizza): destaca a fatia dominante e seu %.
function insightComposicao(items, nomeKey, valorKey){
  const total = sumArr(items.map(i=>i[valorKey]));
  if(!total) return "Sem dados no período.";
  const maior = [...items].sort((a,b)=>b[valorKey]-a[valorKey])[0];
  return `${maior[nomeKey]} concentra ${(maior[valorKey]/total*100).toFixed(0)}% do total.`;
}

/* ---------- Navegação ---------- */
const pages = ["overview","entrada","entregas","manutencao","diesel","folha","horaextra","compras","atestados","infracoes","acidentes","contaspagar","faturamento","emissaonf","belem","ordens","frota","organograma","acessos","gerencial"];
const PAGINAS_SO_DIRETOR = ["gerencial","faturamento","emissaonf","contaspagar","belem","ordens","organograma","acessos"];
// Perfil "lider": entra no sistema e só enxerga o Status da Frota
const PAGINAS_LIDER = ["frota"];
// Perfis que enxergam só uma tela: líder → Status da Frota; monitoramento → Programação de Entregas
const PAGINAS_RESTRITAS = { lider:["frota"], monitoramento:["entregas"], coordenacao:["emissaonf","frota"], manutencao:["emissaonf"], rh:["organograma"], oficina:["manutencao"], administrativo:["emissaonf","organograma"], preos:["emissaonf"], frotaoficina:["frota"] };
const titles = {
  overview: ["Painel Executivo","Consolidado de indicadores · Avance Transporte Logístico"],
  entrada: ["Entrada de Dados","Lance valores por dia, semana ou mês — os gráficos atualizam na hora"],
  contaspagar: ["Contas a Pagar","Prestadores de serviço — vencimentos, status e forma de pagamento"],
  organograma: ["Organograma","Colaboradores por local, função e liderança"],
  gerencial: ["Painel Gerencial","Todas as operações e o status de cada uma — da operação ao recebimento da NF"],
  emissaonf: ["Emissão de NF","Lançamento das notas por contrato, serviço ou balsa, minuta e vencimento"],
  faturamento: ["Faturamento","Contratos faturados — controle mensal por vencimento e resumo por balsa/viagem"],
  acessos: ["Gestão de Acessos","Libere ou altere o perfil de cada pessoa cadastrada no sistema"],
  belem: ["Operação Belém","Combustível, mão de obra e peças — com DRE do resultado mensal"],
  frota: ["Status da Frota","Atividade, motorista e status de cada caminhão no dia"],
  ordens: ["Ordens de Serviço","Pedido, orçamentos, aprovação, execução e pagamento de serviços de manutenção"],
  entregas: ["Entregas","Coletas e entregas — receita, viagens e ranking por motorista, cliente e transportadora"],
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
  // Reforço além de esconder os botões no menu: mesmo se alguém forçar a navegação (ex: console do
  // navegador), quem não é Diretor cai de volta no Painel Executivo.
  // Perfis restritos só abrem as telas deles (que podem ser telas da Diretoria, ex: Organograma)
  const restritas = PAGINAS_RESTRITAS[MEU_PAPEL];
  if(restritas){ if(!restritas.includes(page)) page = restritas[0]; }
  else if(PAGINAS_SO_DIRETOR.includes(page) && MEU_PAPEL !== "diretor") page = "overview";
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
   FILTRO DE ANO — Diesel, Manutenção de Carreta e Compras de Peças
   ----------------------------------------------------------------------------
   "todos" = sem filtro (usa DATA.x direto). Um ano específico = renderers.x monta
   uma "visão filtrada" via computarXStats(lancamentos do ano) e guarda em xView,
   que tanto renderers.x quanto initCharts.x leem — sem mexer no DATA.x real.
   ============================================================================ */
const FILTRO_ANO = { diesel:"todos", manutencao:"todos", compras:"todos", infracoes:"todos", entregas:"todos" };
// Última "visão" (filtrada ou não) montada pelo renderers.x de cada módulo — initCharts.x lê daqui
// em vez de DATA.x direto, pra ficar em sincronia com o filtro de ano sem precisar mudar navigate().
let dieselView = null, manutencaoView = null, comprasView = null, infracoesView = null, entregasView = null;
window.setFiltroAno = (modulo, ano) => {
  FILTRO_ANO[modulo] = ano;
  navigate(modulo);
};
// Monta o <div> com os botões de filtro (Todos + um por ano com lançamento) — some sozinho se só
// houver 1 ano de dados (nada pra filtrar) ou nenhum lançamento ainda.
function montarFiltroAno(modulo, lancamentos){
  const anos = [...new Set(lancamentos.map(r=>r.d.slice(0,4)))].sort();
  if(anos.length < 2) return "";
  const atual = FILTRO_ANO[modulo];
  const btn = (valor,label) => `<button class="sub-tab-btn ${atual===valor?"active":""}" onclick="setFiltroAno('${modulo}','${valor}')">${label}</button>`;
  return `<div class="tabs" style="margin-top:10px;">${btn("todos","Todos")}${anos.map(a=>btn(a,a)).join("")}</div>`;
}

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
const RECOMPUTE_FN = { recomputeDiesel, recomputeManutencao, recomputeFolha, recomputeHoraExtraCusto, recomputeHoraExtraQtd, recomputeInfracoes, deriveCompras, deriveManutencao, deriveDiesel, deriveInfracoes, deriveEntregas };

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
    else if(d.containerPath === "diesel.lancamentos") deriveDiesel();
    else if(d.containerPath === "infracoes.lancamentos") deriveInfracoes();
    else if(d.containerPath === "entregas.lancamentos") deriveEntregas();
    if(sb && d.sbTable && d.sbId) await sb.from(d.sbTable).delete().eq("id", d.sbId);
  } else if(d.kind === "bulkImportFolha"){
    Object.assign(DATA.folha, d.anteriores);
    recomputeFolha();
    if(sb){
      await sb.from("series_periodo").delete().eq("modulo","folha");
      const rows = [];
      d.anteriores.labels.forEach((label,i)=>{
        ["vtVr","ad40","salario"].forEach(campo=>{
          const v = d.anteriores[campo][i];
          if(v!=null) rows.push({ modulo:"folha", campo, label, valor:v });
        });
      });
      if(rows.length) await sbBulkInsert("series_periodo", rows);
    }
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
  } else if(d.kind === "bulkImportDiesel"){
    DATA.diesel.lancamentos = d.anteriores;
    deriveDiesel();
    if(sb){
      await sb.from("diesel_abastecimentos").delete().not("id","is",null);
      if(d.anteriores.length) await sbBulkInsert("diesel_abastecimentos", d.anteriores.map(r=>({ data:r.d, placa:r.placa, km:r.km, litros:r.litros, valor_unitario:r.valorUnit, valor:r.v, motorista:r.motorista, posto:r.posto, status:r.status })));
    }
  } else if(d.kind === "bulkImportInfracoes"){
    DATA.infracoes.lancamentos = d.anteriores;
    deriveInfracoes();
    if(sb){
      await sb.from("infracoes_lancamentos").delete().not("id","is",null);
      if(d.anteriores.length) await sbBulkInsert("infracoes_lancamentos", d.anteriores.map(r=>({ data:r.d, motorista:r.motorista, placa:r.placa, turno:r.turno, hora:r.hora||null, ocorrencia:r.ocorrencia, observacoes:r.observacoes||null })));
    }
  } else if(d.kind === "bulkImportEntregas"){
    DATA.entregas.lancamentos = d.anteriores;
    deriveEntregas();
    if(sb){
      await sb.from("entregas_lancamentos").delete().not("id","is",null);
      if(d.anteriores.length) await sbBulkInsert("entregas_lancamentos", d.anteriores.map(r=>({ data:r.d, servico:r.servico, transportadora:r.transportadora, cliente:r.cliente, motorista:r.motorista, carro:r.carro, qnt:r.qnt, valor:r.v, observacao:r.observacao||null })));
    }
  } else if(d.kind === "bulkImportContasPagar"){
    DATA.contasPagar.lancamentos = d.anteriores;
    if(sb){
      await sb.from("contas_pagar").delete().not("id","is",null);
      if(d.anteriores.length) await sbBulkInsert("contas_pagar", d.anteriores.map(r=>({
        prestador:r.prestador, cnpj:r.cnpj, tipo_servico:r.tipoServico, servico:r.servico, numero_documento:r.numeroDocumento,
        data_emissao:r.dataEmissao, parcela:r.parcela, valor:r.valor, forma_pagamento:r.formaPagamento,
        data_vencimento:r.dataVencimento, status:r.status, data_pagamento:r.dataPagamento
      })));
    }
  } else if(d.kind === "bulkImportAtestados"){
    DATA.atestados.lancamentos = d.anteriores;
    if(sb){
      await sbSubstituirTabela("atestados_lancamentos", d.anteriores.map(r=>({
        data:r.d, colaborador:r.colaborador, motivo:r.motivo, categoria:r.categoria,
        horas:r.horas, dias:r.dias, data_retorno:r.dataRetorno, observacao:r.observacao
      })));
    }
  } else if(d.kind === "bulkImportHoraExtra"){
    DATA.horaExtra.lancamentos = d.anteriores;
    deriveHoraExtra();
    if(sb) await sbSubstituirTabela("horaextra_lancamentos", d.anteriores.map(heParaBanco));
  } else if(d.kind === "bulkImportBelem"){
    DATA.belem.lancamentos = d.anteriores;
    if(sb){
      await substituirCategoriaBelem(d.categoria, d.anteriores.filter(r=>r.categoria===d.categoria).map(r=>({
        data:r.d, categoria:r.categoria, descricao:r.descricao, referencia:r.referencia, quantidade:r.qtd, valor:r.v
      })));
    }
  } else if(d.kind === "bulkImportFaturamento"){
    DATA.faturamento.lancamentos = d.anteriores;
    if(sb){
      await sb.from("faturamento_lancamentos").delete().not("id","is",null);
      if(d.anteriores.length) await sbBulkInsert("faturamento_lancamentos", d.anteriores.map(r=>({
        contrato:r.contrato, nf:r.nf, deadline:r.deadline, doc:r.doc, balsa_viagem:r.balsaViagem, valor:r.valor, vencimento:r.vencimento
      })));
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
  // f.labels só cresce por upsertPeriod (usado tanto pelo lançamento manual quanto pelo
  // carregamento do banco via série_periodo) — um mês novo entra sempre no FIM do array, não na
  // posição cronológica certa. Isso é inofensivo lançamento a lançamento, mas depois de recarregar
  // do banco (onde as linhas voltam fora de ordem) deixa o array inteiro embaralhado. Reordena tudo
  // aqui sempre, antes de qualquer cálculo — assim os gráficos nunca veem uma ordem errada.
  const parseLabel = (l) => { const b = l.indexOf("/"); return { ano:Number("20"+l.slice(b+1,b+3)), mes:MONTH_ABBR.indexOf(l.slice(0,b)) }; };
  const ordem = f.labels.map((_,i)=>i).sort((a,b)=>{
    const A = parseLabel(f.labels[a]), B = parseLabel(f.labels[b]);
    return (A.ano - B.ano) || (A.mes - B.mes);
  });
  f.labels = ordem.map(i=>f.labels[i]);
  f.vtVr = ordem.map(i=>f.vtVr[i]);
  f.ad40 = ordem.map(i=>f.ad40[i]);
  f.salario = ordem.map(i=>f.salario[i]);
  // "Total de Salário" (linha do mês) = 40% Adicional + Salário (VT+VR é benefício e não entra nesse total)
  f.total = f.labels.map((_,i)=> (f.ad40[i]||0)+(f.salario[i]||0));
}

/* ============================================================================
   FOLHA — filtros (Ano, Mês, Categoria) e resumos anuais
   ----------------------------------------------------------------------------
   Os totais anuais e o crescimento ano a ano NÃO são mais digitados à mão (como
   era antes) — vêm sempre somados da própria série mensal, pra nunca ficar
   desatualizado depois de uma importação nova.
   ============================================================================ */
const FILTRO_FOLHA = { ano:"todos", mes:"todos", categoria:"todos" };
window.setFiltroFolha = (campo, valor) => {
  FILTRO_FOLHA[campo] = valor;
  navigate("folha");
};
// Índices de DATA.folha.labels que batem com os filtros de Ano/Mês (a Categoria não filtra a série,
// só troca qual valor aparece nos KPIs/gráfico — ver renderers.folha).
function filtrarFolhaIndices(filtros){
  return DATA.folha.labels.map((_,i)=>i).filter(i=>{
    const label = DATA.folha.labels[i];
    const barra = label.indexOf("/");
    const ano = "20" + label.slice(barra+1, barra+3);
    const mesNum = MONTH_ABBR.indexOf(label.slice(0,barra)) + 1;
    if(filtros.ano !== "todos" && ano !== filtros.ano) return false;
    if(filtros.mes !== "todos" && String(mesNum) !== filtros.mes) return false;
    return true;
  });
}
// Soma um campo (vtVr/ad40/salario) de DATA.folha só nos meses "fechados" (com valor preenchido)
// de um ano específico — usado pros totais anuais e pra comparação ano a ano.
function somaFolhaAno(campo, ano){
  let soma = 0, meses = 0;
  DATA.folha.labels.forEach((label,i)=>{
    if(!label.endsWith("/"+ano.slice(2))) return;
    if(DATA.folha.salario[i] == null) return; // mês ainda não fechado
    soma += DATA.folha[campo][i] || 0;
    meses++;
  });
  return { soma, meses };
}
// Compara o total de Ad.40%+Salário do ano mais recente com dados fechados contra o mesmo número
// de meses do ano anterior (jan-jul/26 vs jan-jul/25, por ex.) — período igual, não ano fechado
// inteiro vs parcial.
function compararFolhaAnoAnterior(anoRef){
  const anos = [...new Set(DATA.folha.labels.map(l=>"20"+l.slice(-2)))].sort();
  const anoAtual = anoRef && anos.includes(anoRef) ? anoRef : anos[anos.length-1];
  if(!anoAtual) return null;
  const atualAd = somaFolhaAno("ad40", anoAtual), atualSal = somaFolhaAno("salario", anoAtual);
  const totalAtual = atualAd.soma + atualSal.soma, mesesFechados = atualSal.meses;
  if(mesesFechados === 0) return { ano:anoAtual, totalAtual:0, mesesFechados:0, comparavel:false };
  const anoAnterior = String(Number(anoAtual)-1);
  if(!anos.includes(anoAnterior)) return { ano:anoAtual, totalAtual, mesesFechados, comparavel:false };
  let totalAnterior = 0;
  for(let m=1; m<=mesesFechados; m++){
    const label = MONTH_ABBR[m-1] + "/" + anoAnterior.slice(2);
    const idx = DATA.folha.labels.indexOf(label);
    if(idx !== -1) totalAnterior += (DATA.folha.ad40[idx]||0) + (DATA.folha.salario[idx]||0);
  }
  const crescimentoPct = totalAnterior ? Math.round((totalAtual-totalAnterior)/totalAnterior*100) : null;
  return { ano:anoAtual, anoAnterior, totalAtual, totalAnterior, mesesFechados, crescimentoPct, comparavel: totalAnterior>0 };
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

// Snapshot das Infrações como vieram do data.js — mesma ideia do DIESEL_BASELINE_AGREGADOS, usado
// como fallback enquanto nenhuma planilha/lançamento avulso for importado.
const INFRACOES_BASELINE_AGREGADOS = {
  labels: [...DATA.infracoes.labels], ocorrencias: [...DATA.infracoes.ocorrencias],
  totalAno2026: DATA.infracoes.totalAno2026, usoCelular2026: DATA.infracoes.usoCelular2026,
  porTurno: { ...DATA.infracoes.porTurno }, porTipo: DATA.infracoes.porTipo.map(t=>({ ...t })),
  topMotoristas: DATA.infracoes.topMotoristas.map(t=>({ ...t })), topPlacas: DATA.infracoes.topPlacas.map(t=>({ ...t })),
  diario: { labels:[...DATA.infracoes.diario.labels], turno1:[...DATA.infracoes.diario.turno1], turno2:[...DATA.infracoes.diario.turno2] }
};

// Calcula os totais de Infrações (mensal, por turno, por tipo, rankings, diário) a partir de uma
// LISTA de ocorrências — função pura, não mexe em DATA.infracoes. Usada tanto pra recalcular o
// estado real (deriveInfracoes, com TODAS as ocorrências) quanto pra gerar a "visão filtrada"
// quando o usuário escolhe um ano específico no filtro da página (ver renderers.infracoes).
function computarInfracoesStats(lancamentos){
  const monthMap = {}, tipoMap = {}, motoristaMap = {}, placaMap = {}, dayMap = {};
  const turno = { turno1:0, turno2:0 };
  let usoCelular = 0;
  lancamentos.forEach(r=>{
    const ym = r.d.slice(0,7);
    monthMap[ym] = (monthMap[ym]||0) + 1;

    if(r.turno === "1") turno.turno1++;
    else if(r.turno === "2") turno.turno2++;

    const tipo = r.ocorrencia || "Outros";
    tipoMap[tipo] = (tipoMap[tipo]||0) + 1;

    if(r.motorista) motoristaMap[r.motorista] = (motoristaMap[r.motorista]||0) + 1;
    if(r.placa) placaMap[r.placa] = (placaMap[r.placa]||0) + 1;

    if(!dayMap[r.d]) dayMap[r.d] = { turno1:0, turno2:0 };
    if(r.turno === "1") dayMap[r.d].turno1++;
    else if(r.turno === "2") dayMap[r.d].turno2++;

    if((r.observacoes||"").toUpperCase().includes("USO DE CELULAR")) usoCelular++;
  });

  const monthKeys = Object.keys(monthMap).sort();
  const labels = monthKeys.map(k=>{ const [y,mm] = k.split("-"); return MONTH_ABBR[parseInt(mm,10)-1] + "/" + y.slice(2); });
  const ocorrencias = monthKeys.map(k=>monthMap[k]);

  const porTipo = Object.entries(tipoMap).sort((a,b)=>b[1]-a[1]).map(([tipo,valor])=>({ tipo, valor }));
  const topMotoristas = Object.entries(motoristaMap).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([nome,total])=>({ nome, total }));
  const topPlacas = Object.entries(placaMap).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([placa,total])=>({ placa, total }));

  const dayKeys = Object.keys(dayMap).sort();
  const diario = {
    labels: dayKeys.map(k=>{ const [,mm,dd] = k.split("-"); return `${dd}/${MONTH_ABBR[parseInt(mm,10)-1]}`; }),
    turno1: dayKeys.map(k=>dayMap[k].turno1),
    turno2: dayKeys.map(k=>dayMap[k].turno2)
  };

  return { lancamentos, labels, ocorrencias, totalPeriodo: lancamentos.length, usoCelular, porTurno: turno, porTipo, topMotoristas, topPlacas, diario };
}

// Recalcula DATA.infracoes a partir de TODAS as ocorrências. Só entra em ação depois do primeiro
// lançamento (avulso ou por importação de planilha); até lá (ou se todas forem excluídas de novo),
// os valores originais do data.js continuam valendo.
function deriveInfracoes(){
  const inf = DATA.infracoes;
  if(!Array.isArray(inf.lancamentos)) inf.lancamentos = [];
  if(inf.lancamentos.length === 0){
    inf.labels = [...INFRACOES_BASELINE_AGREGADOS.labels];
    inf.ocorrencias = [...INFRACOES_BASELINE_AGREGADOS.ocorrencias];
    inf.totalAno2026 = INFRACOES_BASELINE_AGREGADOS.totalAno2026;
    inf.usoCelular2026 = INFRACOES_BASELINE_AGREGADOS.usoCelular2026;
    inf.totalPeriodo = INFRACOES_BASELINE_AGREGADOS.totalAno2026;
    inf.usoCelular = INFRACOES_BASELINE_AGREGADOS.usoCelular2026;
    inf.porTurno = { ...INFRACOES_BASELINE_AGREGADOS.porTurno };
    inf.porTipo = INFRACOES_BASELINE_AGREGADOS.porTipo.map(t=>({ ...t }));
    inf.topMotoristas = INFRACOES_BASELINE_AGREGADOS.topMotoristas.map(t=>({ ...t }));
    inf.topPlacas = INFRACOES_BASELINE_AGREGADOS.topPlacas.map(t=>({ ...t }));
    inf.diario = { labels:[...INFRACOES_BASELINE_AGREGADOS.diario.labels], turno1:[...INFRACOES_BASELINE_AGREGADOS.diario.turno1], turno2:[...INFRACOES_BASELINE_AGREGADOS.diario.turno2] };
    return;
  }
  Object.assign(inf, computarInfracoesStats(inf.lancamentos));
  const lanc2026 = inf.lancamentos.filter(r=>r.d.startsWith("2026"));
  inf.totalAno2026 = lanc2026.length;
  inf.usoCelular2026 = lanc2026.filter(r=>(r.observacoes||"").toUpperCase().includes("USO DE CELULAR")).length;
}

// Calcula os totais de Entregas (mensal, quinzenal, por tipo de serviço, rankings) a partir de uma
// LISTA de operações — função pura, não mexe em DATA.entregas. Usada tanto pra recalcular o estado
// real (deriveEntregas, com TODAS as operações) quanto pra gerar a "visão filtrada" quando o usuário
// escolhe um ano específico no filtro da página (ver renderers.entregas).
function computarEntregasStats(lancamentos){
  const monthMap = {}, quinzenaMap = {}, tipoMap = {}, motoristaMap = {}, clienteMap = {}, transpMap = {};
  let totalValor = 0, totalQtd = 0;
  lancamentos.forEach(r=>{
    const ym = r.d.slice(0,7);
    monthMap[ym] = (monthMap[ym]||0) + r.v;

    const dia = parseInt(r.d.slice(8,10),10);
    const qk = ym + "-" + (dia<=15 ? "Q1" : "Q2");
    quinzenaMap[qk] = (quinzenaMap[qk]||0) + r.qnt;

    const tipo = r.servico || "(Em branco)";
    tipoMap[tipo] = (tipoMap[tipo]||0) + r.v;

    if(r.motorista) motoristaMap[r.motorista] = (motoristaMap[r.motorista]||0) + r.qnt;
    if(r.cliente){
      if(!clienteMap[r.cliente]) clienteMap[r.cliente] = { valor:0, qtd:0 };
      clienteMap[r.cliente].valor += r.v;
      clienteMap[r.cliente].qtd += r.qnt;
    }
    if(r.transportadora) transpMap[r.transportadora] = (transpMap[r.transportadora]||0) + r.v;

    totalValor += r.v;
    totalQtd += r.qnt;
  });

  const monthKeys = Object.keys(monthMap).sort();
  const mensalLabels = monthKeys.map(k=>{ const [y,mm] = k.split("-"); return MONTH_ABBR[parseInt(mm,10)-1] + "/" + y.slice(2); });
  const mensalValor = monthKeys.map(k=>Math.round(monthMap[k]));

  const quinzenaKeys = Object.keys(quinzenaMap).sort();
  const quinzenaLabels = quinzenaKeys.map(k=>{ const [y,mm,q] = k.split("-"); return `${q} ${MONTH_ABBR[parseInt(mm,10)-1]}`; });
  const quinzenaQtd = quinzenaKeys.map(k=>quinzenaMap[k]);

  const porTipo = Object.entries(tipoMap).sort((a,b)=>b[1]-a[1]).map(([tipo,valor])=>({ tipo, valor:Math.round(valor), pct: totalValor ? +(valor/totalValor*100).toFixed(2) : 0 }));
  const porMotorista = Object.entries(motoristaMap).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([nome,viagens])=>({ nome, viagens }));
  const porCliente = Object.entries(clienteMap).sort((a,b)=>b[1].valor-a[1].valor).slice(0,10)
    .map(([cliente,d])=>({ cliente, valor:Math.round(d.valor), qtd:d.qtd, pct: totalValor ? +(d.valor/totalValor*100).toFixed(2) : 0 }));
  const porTransportadora = Object.entries(transpMap).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([transportadora,valor])=>({ transportadora, valor:Math.round(valor) }));

  return {
    lancamentos, mensalLabels, mensalValor, quinzenaLabels, quinzenaQtd, porTipo, porMotorista, porCliente, porTransportadora,
    totalReceitas: Math.round(totalValor), totalViagens: totalQtd, ticketMedio: totalQtd ? +(totalValor/totalQtd).toFixed(2) : 0
  };
}

// Recalcula DATA.entregas a partir de TODAS as operações. Módulo sem baseline agregada (não existia
// antes) — enquanto não houver nenhum lançamento, computarEntregasStats([]) já devolve tudo zerado/
// vazio, e o renderer mostra o estado vazio.
function deriveEntregas(){
  const e = DATA.entregas;
  if(!Array.isArray(e.lancamentos)) e.lancamentos = [];
  Object.assign(e, computarEntregasStats(e.lancamentos));
}

/* ============================================================================
   CONTAS A PAGAR — filtros (Ano, Mês, Status, Fornecedor, Tipo de Serviço) e estatísticas
   ============================================================================ */
const FILTRO_CONTAS = { ano:"todos", mes:"todos", status:"todos", fornecedor:"todos", tipo:"todos" };
let FILTRO_AGENDA = "Vencido"; // qual "balde" de situação a tabela "Agenda de Vencimentos" mostra
window.setFiltroContas = (campo, valor) => {
  FILTRO_CONTAS[campo] = valor;
  navigate("contaspagar");
};
window.setFiltroAgenda = (situacao) => {
  FILTRO_AGENDA = situacao;
  navigate("contaspagar");
};

// Aplica os filtros da página (Ano/Mês/Status/Fornecedor/Tipo) a uma lista de contas. Os gráficos de
// "Análise Mensal" chamam isso com skipMes:true — não faz sentido aplicar o filtro de mês num
// gráfico cuja função é mostrar justamente a quebra mês a mês.
function filtrarContas(lancamentos, filtros, skipMes){
  return lancamentos.filter(i=>{
    if(filtros.status !== "todos" && i.status !== filtros.status) return false;
    if(filtros.fornecedor !== "todos" && i.prestador !== filtros.fornecedor) return false;
    if(filtros.tipo !== "todos" && i.tipoServico !== filtros.tipo) return false;
    const precisaData = filtros.ano !== "todos" || (!skipMes && filtros.mes !== "todos");
    if(precisaData){
      if(!i.dataVencimento) return false;
      const [ano,mes] = i.dataVencimento.split("-");
      if(filtros.ano !== "todos" && ano !== filtros.ano) return false;
      if(!skipMes && filtros.mes !== "todos" && String(parseInt(mes,10)) !== filtros.mes) return false;
    }
    return true;
  });
}

// Totais/rankings mensais (Total, Pago, A Pagar, Quantidade por mês, Top tipo de serviço, Top
// fornecedores) a partir de uma LISTA de contas — função pura, não mexe em DATA.contasPagar.
function computarContasPagarStats(lancamentos){
  const totalMes = Array(12).fill(0), pagoMes = Array(12).fill(0), aPagarMes = Array(12).fill(0), qtdMes = Array(12).fill(0);
  const porTipo = {}, porFornecedor = {};
  lancamentos.forEach(i=>{
    if(i.dataVencimento){
      const mIdx = parseInt(i.dataVencimento.slice(5,7),10) - 1;
      if(mIdx>=0 && mIdx<12){
        totalMes[mIdx] += i.valor;
        qtdMes[mIdx] += 1;
        if(i.status === "Pago") pagoMes[mIdx] += i.valor; else aPagarMes[mIdx] += i.valor;
      }
    }
    const tipo = i.tipoServico || "Sem categoria";
    porTipo[tipo] = (porTipo[tipo]||0) + i.valor;
    const forn = i.prestador || "Sem fornecedor";
    porFornecedor[forn] = (porFornecedor[forn]||0) + i.valor;
  });
  const porTipoArr = Object.entries(porTipo).sort((a,b)=>b[1]-a[1]).map(([tipo,valor])=>({ tipo, valor:Math.round(valor) }));
  const topFornecedores = Object.entries(porFornecedor).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([fornecedor,valor])=>({ fornecedor, valor:Math.round(valor) }));
  return {
    mesesLabels: MONTH_ABBR.map(m=>m[0].toUpperCase()+m.slice(1)),
    totalMes: totalMes.map(Math.round), pagoMes: pagoMes.map(Math.round), aPagarMes: aPagarMes.map(Math.round), qtdMes,
    porTipoArr, topFornecedores
  };
}

/* ============================================================================
   ATESTADOS — filtros (Ano, Mês) e estatísticas por ocorrência
   ============================================================================ */
const FILTRO_ATESTADOS = { ano:"todos", mes:"todos" };
window.setFiltroAtestados = (campo, valor) => {
  FILTRO_ATESTADOS[campo] = valor;
  navigate("atestados");
};

// Mesma convenção do Contas a Pagar: os gráficos de evolução mensal chamam com skipMes:true, porque
// filtrar por mês num gráfico que existe justamente pra comparar os meses deixaria uma barra só.
function filtrarAtestados(lancamentos, filtros, skipMes){
  return lancamentos.filter(i=>{
    if(!i.d) return false;
    const [ano, mes] = i.d.split("-");
    if(filtros.ano !== "todos" && ano !== filtros.ano) return false;
    if(!skipMes && filtros.mes !== "todos" && String(parseInt(mes,10)) !== filtros.mes) return false;
    return true;
  });
}

// Totais, evolução mensal e rankings a partir de uma LISTA de atestados — função pura.
function computarAtestadosStats(lancamentos){
  const atestadosMes = Array(12).fill(0), diasMes = Array(12).fill(0);
  const porColaborador = {}, porMotivo = {}, porCategoria = {};
  let totalDias = 0, totalHoras = 0;

  lancamentos.forEach(i=>{
    const mIdx = parseInt(i.d.slice(5,7),10) - 1;
    if(mIdx>=0 && mIdx<12){ atestadosMes[mIdx] += 1; diasMes[mIdx] += (i.dias||0); }
    totalDias += (i.dias||0);
    totalHoras += (i.horas||0);
    const acumular = (mapa, chave) => {
      const k = chave || "Não informado";
      if(!mapa[k]) mapa[k] = { qtd:0, dias:0 };
      mapa[k].qtd += 1; mapa[k].dias += (i.dias||0);
    };
    acumular(porColaborador, i.colaborador);
    acumular(porMotivo, i.motivo);
    acumular(porCategoria, i.categoria);
  });

  // Rankings ordenados por DIAS perdidos (impacto real na operação), com a quantidade junto.
  const ranking = (mapa, nomeCampo, limite) => Object.entries(mapa)
    .sort((a,b)=> b[1].dias - a[1].dias || b[1].qtd - a[1].qtd)
    .slice(0, limite)
    .map(([nome,v])=>({ [nomeCampo]:nome, qtd:v.qtd, dias:+v.dias.toFixed(2) }));

  const colaboradoresDistintos = Object.keys(porColaborador).length;
  return {
    mesesLabels: MONTH_ABBR.map(m=>m[0].toUpperCase()+m.slice(1)),
    atestadosMes, diasMes: diasMes.map(v=>+v.toFixed(2)),
    totalAtestados: lancamentos.length,
    totalDias: +totalDias.toFixed(2),
    totalHoras: +totalHoras.toFixed(2),
    colaboradoresDistintos,
    mediaDiasPorAtestado: lancamentos.length ? +(totalDias/lancamentos.length).toFixed(2) : 0,
    mediaDiasPorColaborador: colaboradoresDistintos ? +(totalDias/colaboradoresDistintos).toFixed(2) : 0,
    topColaboradores: ranking(porColaborador, "nome", 10),
    topMotivos: ranking(porMotivo, "motivo", 10),
    porCategoria: ranking(porCategoria, "categoria", 99)
  };
}

/* ============================================================================
   OPERAÇÃO BELÉM — custos por categoria e DRE mensal
   ============================================================================ */
const RECEITA_BELEM_PADRAO = 85000; // receita bruta de contrato; cada mês pode ser ajustado na tela
const BELEM_CATEGORIAS = [
  { chave:"combustivel", label:"Combustível", cor:"#D0021B" },
  { chave:"mao_de_obra", label:"Mão de Obra", cor:"#17181C" },
  { chave:"pecas",       label:"Peças",       cor:"#E1971F" }
];
const FILTRO_BELEM = { ano:"todos" };
window.setFiltroBelem = (campo, valor) => {
  FILTRO_BELEM[campo] = valor;
  navigate("belem");
};

// Monta o DRE mês a mês: soma os custos de cada categoria, pega a receita do mês (o valor editado
// para aquele mês, ou o padrão de contrato) e fecha com resultado e margem. Função pura — devolve
// tudo pronto pra tela, sem mexer em DATA.belem.
function computarBelemStats(lancamentos, receitaOverrides, filtroAno){
  const itens = filtroAno && filtroAno !== "todos"
    ? lancamentos.filter(r=>r.d && r.d.startsWith(filtroAno))
    : lancamentos;

  const porMes = {};
  const garantirMes = (mes) => {
    if(!porMes[mes]) porMes[mes] = { mes, combustivel:0, mao_de_obra:0, pecas:0 };
    return porMes[mes];
  };
  itens.forEach(r=>{
    if(!r.d) return;
    const mes = r.d.slice(0,7);
    const linha = garantirMes(mes);
    if(linha[r.categoria] != null) linha[r.categoria] += r.v;
  });
  // Um mês que teve a receita editada aparece no DRE mesmo sem nenhum custo lançado ainda.
  Object.keys(receitaOverrides||{}).forEach(mes=>{
    if(!filtroAno || filtroAno === "todos" || mes.startsWith(filtroAno)) garantirMes(mes);
  });

  const linhas = Object.values(porMes).sort((a,b)=>a.mes.localeCompare(b.mes)).map(l=>{
    const custoTotal = l.combustivel + l.mao_de_obra + l.pecas;
    const receita = (receitaOverrides && receitaOverrides[l.mes] != null) ? receitaOverrides[l.mes] : RECEITA_BELEM_PADRAO;
    const resultado = receita - custoTotal;
    return { ...l, label: rotuloMesBelem(l.mes), custoTotal, receita, resultado,
             margem: receita ? (resultado/receita*100) : 0 };
  });

  const soma = (campo) => linhas.reduce((s,l)=>s+l[campo], 0);
  const receitaTotal = soma("receita"), custoTotal = soma("custoTotal");
  return {
    linhas,
    labels: linhas.map(l=>l.label),
    receitaTotal, custoTotal,
    resultadoTotal: receitaTotal - custoTotal,
    margemTotal: receitaTotal ? ((receitaTotal - custoTotal)/receitaTotal*100) : 0,
    porCategoria: BELEM_CATEGORIAS.map(c=>({ nome:c.label, valor: soma(c.chave), cor:c.cor }))
  };
}

// "2026-01" -> "jan/26", no mesmo padrão de rótulo usado no resto do painel.
function rotuloMesBelem(mes){
  const [ano, mm] = mes.split("-");
  return MONTH_ABBR[parseInt(mm,10)-1] + "/" + ano.slice(2);
}

/* ============================================================================
   FATURAMENTO — filtros (Ano, Mês, Balsa/Viagem) e estatísticas
   ============================================================================ */
const FILTRO_FATURAMENTO = { ano:"todos", mes:"todos", balsa:"todos" };
window.setFiltroFaturamento = (campo, valor) => {
  FILTRO_FATURAMENTO[campo] = valor;
  navigate("faturamento");
};

// A coluna BALSA/VIAGEM traz o nome do navio + nº da viagem (ex: "MELBOURNE - 16029", às vezes sem o
// espaço antes do número: "TOKYO -8278") ou um rótulo de operação (ex: "LOGISTICA REVERSA"). Pra virar
// um resumo útil, agrupa pelo texto antes do hífen (tolerando espaço de um só lado ou nenhum).
// Agrupa o texto BALSA/VIAGEM pelo serviço ou nome da balsa (mesma regra da tela Emissão de NF,
// que junta variações como "LOG. REVERSA" e "LOGISTICA REVERSA")
function balsaGrupo(raw){
  if(!raw) return "Sem informação";
  return nfClassificar(raw).item;
}

// Aplica os filtros da página (Ano/Mês/Balsa) a uma lista de lançamentos de faturamento. O gráfico de
// "Análise Mensal" chama isso com skipMes:true, pelo mesmo motivo do Contas a Pagar.
function filtrarFaturamento(lancamentos, filtros, skipMes){
  return lancamentos.filter(i=>{
    if(filtros.balsa !== "todos" && balsaGrupo(i.balsaViagem) !== filtros.balsa) return false;
    const precisaData = filtros.ano !== "todos" || (!skipMes && filtros.mes !== "todos");
    if(precisaData){
      if(!i.vencimento) return false;
      const [ano,mes] = i.vencimento.split("-");
      if(filtros.ano !== "todos" && ano !== filtros.ano) return false;
      if(!skipMes && filtros.mes !== "todos" && String(parseInt(mes,10)) !== filtros.mes) return false;
    }
    return true;
  });
}

// Totais mensais (por VENCIMENTO, a pedido) e resumo por Balsa/Viagem a partir de uma LISTA de
// lançamentos — função pura, não mexe em DATA.faturamento.
function computarFaturamentoStats(lancamentos){
  const valorMes = Array(12).fill(0), qtdMes = Array(12).fill(0);
  const porBalsa = {};
  lancamentos.forEach(i=>{
    if(i.vencimento){
      const mIdx = parseInt(i.vencimento.slice(5,7),10) - 1;
      if(mIdx>=0 && mIdx<12){
        valorMes[mIdx] += i.valor;
        qtdMes[mIdx] += 1;
      }
    }
    const grupo = balsaGrupo(i.balsaViagem);
    if(!porBalsa[grupo]) porBalsa[grupo] = { valor:0, qtd:0 };
    porBalsa[grupo].valor += i.valor;
    porBalsa[grupo].qtd += 1;
  });
  const porBalsaArr = Object.entries(porBalsa).sort((a,b)=>b[1].valor-a[1].valor)
    .map(([nome,v])=>({ nome, valor:Math.round(v.valor), qtd:v.qtd }));
  return {
    mesesLabels: MONTH_ABBR.map(m=>m[0].toUpperCase()+m.slice(1)),
    valorMes: valorMes.map(Math.round), qtdMes,
    porBalsaArr
  };
}

// Distingue placa de caminhão de verdade (sempre tem número, ex: "ATP-3089") de centro de custo
// usado na mesma coluna em algumas planilhas de Compras (ex: "ESTOQUE", "PORTO", "MANUTENÇÃO") —
// esses últimos nunca têm dígito, então ficam de fora dos rankings por caminhão sem precisar manter
// uma lista fixa de valores conhecidos.
function pareceCaminhao(placa){
  return /\d/.test(placa||"");
}
// A mesma placa aparece escrita de formas diferentes na planilha ("GCV 3B63" / "GCV-3B63" /
// "GCV3B63"), o que divide o gasto do mesmo caminhão em entradas separadas no ranking — normaliza
// removendo espaço/traço. Só mexe em texto que já parece placa; centro de custo fica como veio.
function normalizarPlaca(placa){
  const p = (placa||"").toString().trim();
  return pareceCaminhao(p) ? p.toUpperCase().replace(/[\s-]+/g,"") : p;
}

// Calcula os totais mensais + rankings do módulo Compras a partir de uma LISTA de lançamentos —
// função pura, não mexe em DATA.compras. Usada tanto pra recalcular o estado real (deriveCompras,
// com TODOS os lançamentos) quanto pra gerar a "visão filtrada" quando o usuário escolhe um ano
// específico no filtro da página (ver renderers.compras).
function computarComprasStats(lancamentos){
  const monthMap = {}, localMap = {}, catMap = {}, placaMap = {};
  let totalGeral = 0;
  lancamentos.forEach(r=>{
    const ym = r.d.slice(0,7);
    monthMap[ym] = (monthMap[ym]||0) + r.v;
    if(r.l) localMap[r.l] = (localMap[r.l]||0) + r.v;
    const cat = r.c || "Sem categoria";
    catMap[cat] = (catMap[cat]||0) + r.v;
    if(r.p && r.p.trim() && pareceCaminhao(r.p)) placaMap[r.p.trim()] = (placaMap[r.p.trim()]||0) + r.v;
    totalGeral += r.v;
  });
  const keys = Object.keys(monthMap).sort();
  const mensalLabels = keys.map(k=>{ const [y,mm] = k.split("-"); return MONTH_ABBR[parseInt(mm,10)-1] + "/" + y.slice(2); });
  const mensal = keys.map(k=> Math.round(monthMap[k]));

  const locaisSorted = Object.entries(localMap).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const topLocais = locaisSorted.map(([local,valor])=>({ local, valor }));
  const topLocaisTotal = Math.round(locaisSorted.reduce((s,[,v])=>s+v,0));

  const porCategoria = Object.entries(catMap).sort((a,b)=>b[1]-a[1]).map(([categoria,valor])=>({ categoria, valor }));

  const placasSorted = Object.values(placaMap).sort((a,b)=>b-a);
  const top10Sum = placasSorted.slice(0,10).reduce((a,b)=>a+b,0);
  const top10CaminhoesPct = totalGeral ? Math.round(top10Sum/totalGeral*100) : 0;

  return { comprasLancamentos: lancamentos, mensalLabels, mensal, totalPeriodo: Math.round(totalGeral), topLocais, topLocaisTotal, porCategoria, top10CaminhoesPct };
}

// Recalcula tudo do módulo Compras a partir dos lançamentos individuais (fonte única da verdade).
function deriveCompras(){
  const c = DATA.compras;
  Object.assign(c, computarComprasStats(c.comprasLancamentos));
  const lanc2026 = c.comprasLancamentos.filter(r=>r.d.startsWith("2026"));
  c.totalAno2026 = Math.round(lanc2026.reduce((s,r)=>s+r.v,0));
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

// Calcula os totais mensais + rankings do módulo Manutenção a partir de uma LISTA de lançamentos —
// função pura, não mexe em DATA.manutencao. Usada tanto pra recalcular o estado real (deriveManutencao,
// com TODOS os lançamentos) quanto pra gerar a "visão filtrada" quando o usuário escolhe um ano
// específico no filtro da página (ver renderers.manutencao).
function computarManutencaoStats(lancamentos){
  const monthMap = {}, placaMap = {}, localMap = {};
  let pendQtd = 0, pendValor = 0;
  lancamentos.forEach(r=>{
    const ym = r.d.slice(0,7);
    if(!monthMap[ym]) monthMap[ym] = { manutencaoGeral:0, pinturaTeto:0, outrosServicos:0 };
    monthMap[ym][categorizarServicoManutencao(r.servico)] += r.v;

    if(r.placa && r.placa.trim()){
      const p = r.placa.trim();
      if(!placaMap[p]) placaMap[p] = { valor:0, qtd:0 };
      placaMap[p].valor += r.v;
      placaMap[p].qtd += 1;
    }
    if(r.local && r.local.trim()){
      const l = r.local.trim();
      if(!localMap[l]) localMap[l] = { valor:0, qtd:0 };
      localMap[l].valor += r.v;
      localMap[l].qtd += 1;
    }
    if((r.status||"").trim().toUpperCase() === "PENDENTE"){
      pendQtd += 1;
      pendValor += r.v;
    }
  });
  const keys = Object.keys(monthMap).sort();
  const labels = keys.map(k=>{ const [y,mm] = k.split("-"); return MONTH_ABBR[parseInt(mm,10)-1] + "/" + y.slice(2); });
  const manutencaoGeral = keys.map(k=>Math.round(monthMap[k].manutencaoGeral));
  const pinturaTeto = keys.map(k=>Math.round(monthMap[k].pinturaTeto));
  const outrosServicos = keys.map(k=>Math.round(monthMap[k].outrosServicos));
  const totalGeral = manutencaoGeral.map((v,i)=> (v||0)+(pinturaTeto[i]||0)+(outrosServicos[i]||0));
  const totalPeriodo = sumArr(totalGeral);
  const totMG = sumArr(manutencaoGeral), totPT = sumArr(pinturaTeto), totOS = sumArr(outrosServicos);
  const composicao = [
    { nome:"Manutenção Geral", valor:totMG, pct: totalPeriodo? Math.round(totMG/totalPeriodo*100):0 },
    { nome:"Pintura do Teto", valor:totPT, pct: totalPeriodo? Math.round(totPT/totalPeriodo*100):0 },
    { nome:"Outros Serviços", valor:totOS, pct: totalPeriodo? Math.round(totOS/totalPeriodo*100):0 }
  ];

  const topCaminhoesValor = Object.entries(placaMap).sort((a,b)=>b[1].valor-a[1].valor).slice(0,10)
    .map(([placa,d])=>({ placa, valor:Math.round(d.valor), qtd:d.qtd }));
  const topCaminhoesFrequencia = Object.entries(placaMap).sort((a,b)=>b[1].qtd-a[1].qtd).slice(0,10)
    .map(([placa,d])=>({ placa, qtd:d.qtd, valor:Math.round(d.valor) }));
  const porLocal = Object.entries(localMap).sort((a,b)=>b[1].valor-a[1].valor)
    .map(([local,d])=>({ local, valor:Math.round(d.valor), qtd:d.qtd }));

  return { lancamentos, labels, manutencaoGeral, pinturaTeto, outrosServicos, totalGeral, totalPeriodo, composicao,
    topCaminhoesValor, topCaminhoesFrequencia, porLocal, pendentes:{ qtd:pendQtd, valor:Math.round(pendValor) } };
}

// Recalcula DATA.manutencao a partir de TODOS os lançamentos. Só entra em ação depois do primeiro
// lançamento (avulso ou por importação de planilha); até lá (ou se todos forem excluídos de novo),
// os valores originais do data.js continuam valendo.
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
    m.topCaminhoesValor = [];
    m.topCaminhoesFrequencia = [];
    m.porLocal = [];
    m.pendentes = { qtd:0, valor:0 };
    return;
  }
  Object.assign(m, computarManutencaoStats(m.lancamentos));
}

// Número da semana ISO 8601 (segunda a domingo) de uma data "YYYY-MM-DD" — usado pra agrupar
// abastecimentos de Diesel por semana, no mesmo estilo "S37/25" do mensal "jul/25".
function isoWeekLabel(iso){
  const d = new Date(iso + "T00:00:00");
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const diff = target - firstThursday;
  const week = 1 + Math.round(diff / (7*24*60*60*1000));
  return `S${week}/${String(target.getFullYear()).slice(2)}`;
}

// Snapshot dos totais de Diesel como vieram do data.js — mesma ideia do MANUTENCAO_BASELINE_AGREGADOS.
const DIESEL_BASELINE_AGREGADOS = {
  mensalLabels: [...DATA.diesel.mensalLabels], mensal: [...DATA.diesel.mensal],
  totalAno2026: DATA.diesel.totalAno2026, mediaSemanal: DATA.diesel.mediaSemanal,
  semanalLabels: [...DATA.diesel.semanalLabels], semanal_x1000: [...DATA.diesel.semanal_x1000],
  topCaminhoes: DATA.diesel.topCaminhoes.map(t=>({ ...t })), topCaminhoesTotalPct: DATA.diesel.topCaminhoesTotalPct
};

// Calcula os totais de Diesel (mensal, semanal, top caminhões) a partir de uma LISTA de
// abastecimentos — função pura, não mexe em DATA.diesel. Usada tanto pra recalcular o estado real
// (deriveDiesel, com TODOS os lançamentos) quanto pra gerar a "visão filtrada" quando o usuário
// escolhe um ano específico no filtro da página (ver renderers.diesel).
function computarDieselStats(lancamentos){
  const monthMap = {}, weekMap = {}, placaMap = {};
  let totalGeral = 0, litrosGeral = 0;
  lancamentos.forEach(r=>{
    const ym = r.d.slice(0,7);
    monthMap[ym] = (monthMap[ym]||0) + r.v;
    const wk = isoWeekLabel(r.d);
    weekMap[wk] = (weekMap[wk]||0) + r.v;
    if(r.placa && r.placa.trim()){
      const p = r.placa.trim();
      placaMap[p] = (placaMap[p]||0) + r.v;
    }
    totalGeral += r.v;
    litrosGeral += (r.litros||0);
  });

  const monthKeys = Object.keys(monthMap).sort();
  const mensalLabels = monthKeys.map(k=>{ const [y,mm] = k.split("-"); return MONTH_ABBR[parseInt(mm,10)-1] + "/" + y.slice(2); });
  const mensal = monthKeys.map(k=>Math.round(monthMap[k]));

  const weekKeys = Object.keys(weekMap).sort((a,b)=>{
    const [wa,ya] = a.slice(1).split("/"), [wb,yb] = b.slice(1).split("/");
    return (ya.padStart(2,"0")+wa.padStart(2,"0")).localeCompare(yb.padStart(2,"0")+wb.padStart(2,"0"));
  });
  const semanalLabels = weekKeys;
  const semanal_x1000 = weekKeys.map(k=>Math.round(weekMap[k]/1000));
  const mediaSemanal = weekKeys.length ? Math.round(weekKeys.reduce((s,k)=>s+weekMap[k],0)/weekKeys.length) : 0;

  const placasSorted = Object.entries(placaMap).sort((a,b)=>b[1]-a[1]);
  const top10 = placasSorted.slice(0,10);
  const top10Sum = top10.reduce((s,[,v])=>s+v,0);
  const topCaminhoes = top10.map(([placa,valor])=>({ placa, valor:Math.round(valor), pct: totalGeral ? +(valor/totalGeral*100).toFixed(2) : 0 }));
  const topCaminhoesTotalPct = totalGeral ? Math.round(top10Sum/totalGeral*100) : 0;

  return {
    lancamentos, mensalLabels, mensal,
    totalPeriodo: Math.round(totalGeral), totalLitrosPeriodo: Math.round(litrosGeral),
    custoMedioLitro: litrosGeral ? +(totalGeral/litrosGeral).toFixed(2) : null,
    mediaSemanal, semanalLabels, semanal_x1000, topCaminhoes, topCaminhoesTotalPct
  };
}

// Recalcula DATA.diesel a partir de TODOS os abastecimentos. Só entra em ação depois do primeiro
// lançamento (avulso ou importação); até lá (ou se todos forem excluídos de novo), os valores
// originais do data.js continuam valendo.
function deriveDiesel(){
  const d = DATA.diesel;
  if(!Array.isArray(d.lancamentos)) d.lancamentos = [];
  if(d.lancamentos.length === 0){
    d.mensalLabels = [...DIESEL_BASELINE_AGREGADOS.mensalLabels];
    d.mensal = [...DIESEL_BASELINE_AGREGADOS.mensal];
    d.totalAno2026 = DIESEL_BASELINE_AGREGADOS.totalAno2026;
    d.mediaSemanal = DIESEL_BASELINE_AGREGADOS.mediaSemanal;
    d.semanalLabels = [...DIESEL_BASELINE_AGREGADOS.semanalLabels];
    d.semanal_x1000 = [...DIESEL_BASELINE_AGREGADOS.semanal_x1000];
    d.topCaminhoes = DIESEL_BASELINE_AGREGADOS.topCaminhoes.map(t=>({ ...t }));
    d.topCaminhoesTotalPct = DIESEL_BASELINE_AGREGADOS.topCaminhoesTotalPct;
    d.totalPeriodo = DIESEL_BASELINE_AGREGADOS.totalAno2026;
    d.totalLitrosPeriodo = null;
    d.totalLitrosAno2026 = null;
    d.custoMedioLitro = null;
    return;
  }

  Object.assign(d, computarDieselStats(d.lancamentos));
  const lanc2026 = d.lancamentos.filter(r=>r.d.startsWith("2026"));
  d.totalAno2026 = Math.round(lanc2026.reduce((s,r)=>s+r.v,0));
  d.totalLitrosAno2026 = Math.round(lanc2026.reduce((s,r)=>s+(r.litros||0),0));
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
        c = DATA.compras, at = DATA.atestados, inf = DATA.infracoes, ac = DATA.acidentes, cp = DATA.contasPagar, eg = DATA.entregas, ft = DATA.faturamento;

  const cpPendente = sumArr(cp.lancamentos.filter(i=>i.status!=="Pago").map(i=>i.valor));
  const cpVencidas = cp.lancamentos.filter(i=>statusConta(i)==="Vencido").length;
  const folhaComp = compararFolhaAnoAnterior();

  const cards = [
    { page:"entregas", ic:"🚚", label:"Entregas", big: eg.lancamentos.length ? fmtBRL(eg.totalReceitas) : "—",
      foot: eg.lancamentos.length ? `${fmtNum(eg.totalViagens)} viagens · ticket médio ${fmtBRL2(eg.ticketMedio)}` : "Nenhuma operação importada ainda", id:"spk-entregas" },
    { page:"manutencao", ic:"🔩", label:"Manutenção de Carreta", big:fmtBRL(m.totalPeriodo), foot:"Total acumulado dez/25–jun/26", id:"spk-manutencao" },
    { page:"diesel", ic:"⛽", label:"Diesel (2026)", big:fmtBRL(d.totalAno2026), foot:"Média semanal " + fmtMil(d.mediaSemanal), id:"spk-diesel" },
    { page:"folha", ic:"💰", label:`Folha · Salário${folhaComp ? ` (${folhaComp.ano})` : ""}`, big: folhaComp ? fmtBRL(folhaComp.totalAtual) : "—",
      foot: (folhaComp && folhaComp.comparavel) ? `${folhaComp.crescimentoPct>=0?"+":""}${folhaComp.crescimentoPct}% vs. ${folhaComp.anoAnterior} (${folhaComp.mesesFechados} ${folhaComp.mesesFechados===1?"mês":"meses"})` : "Sem dados suficientes pra comparar", id:"spk-folha" },
    { page:"horaextra", ic:"⏱️", label:"Hora Extra (jan–jun/26)", big:fmtBRL(he.janJun2026), foot:`+${he.crescimentoPct}% vs. mesmo período 2025`, id:"spk-he" },
    { page:"compras", ic:"🧰", label:"Compras de Peças (2026)", big:fmtBRL(c.totalAno2026), foot:`Top 10 veículos = ${c.top10CaminhoesPct}%`, id:"spk-compras" },
    { page:"atestados", ic:"🩺", label:"Atestados (mai/26)", big:fmtNum(at.ocorrencias[at.ocorrencias.length-1]), foot:"Ocorrências no último mês fechado", id:"spk-atestados" },
    { page:"infracoes", ic:"🚨", label:"Infrações (2026)", big:fmtNum(inf.totalAno2026), foot:`Uso de celular: ${inf.usoCelular2026} ocorrências`, id:"spk-infracoes" },
    { page:"acidentes", ic:"⚠️", label:"Acidentes & Incidentes", big:"0", foot:"Nenhuma ocorrência registrada em 2025", id:"spk-acidentes" },
    { page:"contaspagar", ic:"💵", label:"Contas a Pagar", big:fmtBRL(cpPendente), foot: cpVencidas>0 ? `⚠ ${cpVencidas} conta(s) vencida(s)` : "Nenhuma conta vencida" },
    { page:"faturamento", ic:"🧾", label:"Faturamento", big: ft.lancamentos.length ? fmtBRL(sumArr(ft.lancamentos.map(i=>i.valor))) : "—",
      foot: ft.lancamentos.length ? `${fmtNum(ft.lancamentos.length)} lançamento(s)` : "Nenhum lançamento importado ainda" }
  ];

  return `
    <div class="page-head">
      <h2>Bem-vindo, Fabiano 👋</h2>
      <p>Clique em qualquer indicador abaixo para abrir o módulo completo, com gráficos, tabelas e rankings.</p>
    </div>
    <div class="kpi-grid" style="grid-template-columns:repeat(auto-fit, minmax(230px,1fr));">
      ${cards.filter(c=>!PAGINAS_SO_DIRETOR.includes(c.page) || MEU_PAPEL==="diretor").map(c=>`
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
        <div class="chart-insight">${insightSerie(he.labels, he.y2026, fmtBRL)}</div>
      </div>
      <div class="panel">
        <h3>Distribuição de Infrações por Tipo</h3>
        <div class="hint">Acumulado 2026</div>
        <div class="chart-wrap" style="height:260px;"><canvas id="ov-inf"></canvas></div>
        <div class="chart-insight">${insightComposicao(inf.porTipo, "tipo", "valor")}</div>
      </div>
    </div>

    <div class="panel">
      <h3>Alertas de Gestão</h3>
      <div class="hint">Pontos que merecem atenção do diretor</div>
      <table>
        <thead><tr><th>Área</th><th>Indicador</th><th class="num">Situação</th></tr></thead>
        <tbody>
          ${folhaComp && folhaComp.comparavel ? `<tr><td>Folha</td><td>Crescimento de salário ${folhaComp.anoAnterior}→${folhaComp.ano} (${folhaComp.mesesFechados} ${folhaComp.mesesFechados===1?"mês":"meses"})</td><td class="num"><span class="badge red">${folhaComp.crescimentoPct>=0?"+":""}${folhaComp.crescimentoPct}%</span></td></tr>` : ""}
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
  spark("spk-entregas", DATA.entregas.mensalValor, COLORS.amber);
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
// Aba "Custos" da Manutenção de Carreta (a tela em si é montada junto com o Controle diário)
function manutencaoCustos(){
  const filtro = FILTRO_ANO.manutencao;
  const m = manutencaoView = (filtro === "todos" || DATA.manutencao.lancamentos.length === 0)
    ? DATA.manutencao
    : computarManutencaoStats(DATA.manutencao.lancamentos.filter(r=>r.d.startsWith(filtro)));
  const ultimo = m.totalGeral[m.totalGeral.length-1];
  const penult = m.totalGeral[m.totalGeral.length-2];
  return `
    <div class="page-head"><h2>Manutenção de Carreta</h2><p>Custo em R$ por tipo de serviço, ${m.labels[0]} a ${m.labels[m.labels.length-1]}</p>${montarFiltroAno("manutencao", DATA.manutencao.lancamentos)}</div>
    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Total do período</div><div class="val">${fmtBRL(m.totalPeriodo)}</div></div>
      <div class="kpi"><div class="lbl">Manutenção geral</div><div class="val">${m.composicao[0].pct}%</div>${deltaBadge(0)}</div>
      <div class="kpi"><div class="lbl">Pintura do teto</div><div class="val">${m.composicao[1].pct}%</div></div>
      <div class="kpi"><div class="lbl">Último mês (${m.labels[m.labels.length-1]})</div><div class="val">${fmtBRL(ultimo)}</div>${deltaBadge(deltaPct(ultimo,penult), true)}</div>
      <div class="kpi"><div class="lbl">Serviços pendentes</div><div class="val">${fmtNum(m.pendentes.qtd)}</div><div class="delta flat">${fmtBRL(m.pendentes.valor)} em aberto</div></div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <h3>Custo mensal por serviço</h3>
        <div class="hint">Empilhado — Manutenção Geral, Pintura do Teto e Outros Serviços</div>
        <div class="chart-wrap" style="height:300px;"><canvas id="ch-manut-mensal"></canvas></div>
        <div class="chart-insight">${insightSerie(m.labels, m.totalGeral, fmtBRL)}</div>
      </div>
      <div class="panel">
        <h3>Composição do custo total</h3>
        <div class="hint">% sobre o total do período</div>
        <div class="chart-wrap" style="height:300px;"><canvas id="ch-manut-comp"></canvas></div>
        <div class="chart-insight">${insightComposicao(m.composicao, "nome", "valor")}</div>
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
    ${m.lancamentos.length === 0 ? `
    <div class="panel">
      <div class="empty-state" style="padding:24px;"><div class="glyph">📋</div><p>Rankings por caminhão e por local aparecem aqui depois da primeira importação de planilha ou lançamento avulso.</p></div>
    </div>` : `
    <div class="grid-2">
      <div class="panel">
        <h3>Top 10 caminhões por custo de manutenção</h3>
        <div class="hint">Soma de todos os lançamentos, ${m.labels[0]} a ${m.labels[m.labels.length-1]}</div>
        <table>
          <thead><tr><th>#</th><th>Placa</th><th class="num">Serviços</th><th class="num">Valor total</th></tr></thead>
          <tbody>
            ${m.topCaminhoesValor.map((t,i)=>`<tr><td class="rank">${i+1}</td><td>${t.placa}</td><td class="num">${fmtNum(t.qtd)}</td><td class="num">${fmtBRL2(t.valor)}</td></tr>`).join("")}
          </tbody>
        </table>
      </div>
      <div class="panel">
        <h3>Top 10 caminhões por frequência</h3>
        <div class="hint">Quantidade de vezes na oficina — ajuda a achar veículo com problema recorrente, não só caro</div>
        <table>
          <thead><tr><th>#</th><th>Placa</th><th class="num">Serviços</th><th class="num">Valor total</th></tr></thead>
          <tbody>
            ${m.topCaminhoesFrequencia.map((t,i)=>`<tr><td class="rank">${i+1}</td><td>${t.placa}</td><td class="num">${fmtNum(t.qtd)}</td><td class="num">${fmtBRL2(t.valor)}</td></tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>
    <div class="panel">
      <h3>Custo por local</h3>
      <div class="hint">Onde os serviços foram realizados</div>
      <table>
        <thead><tr><th>Local</th><th class="num">Serviços</th><th class="num">Valor total</th><th class="num">%</th></tr></thead>
        <tbody>
          ${m.porLocal.map(l=>`<tr><td>${l.local}</td><td class="num">${fmtNum(l.qtd)}</td><td class="num">${fmtBRL2(l.valor)}</td><td class="num">${m.totalPeriodo ? (l.valor/m.totalPeriodo*100).toFixed(1) : "0"}%</td></tr>`).join("")}
        </tbody>
      </table>
    </div>`}
  `;
};
function manutencaoCustosCharts(){
  const m = manutencaoView || DATA.manutencao;
  // Total do mês escrito em preto acima de cada coluna, sem "R$" (ex: 146,5K)
  const totMes = m.labels.map((_,i)=>(m.manutencaoGeral[i]||0)+(m.pinturaTeto[i]||0)+(m.outrosServicos[i]||0));
  const fmtTopo = (v) => fmtLabelBRL(v).replace("R$ ","");
  const totalNoTopo = {
    id:"manutTotais",
    afterDatasetsDraw(chart){
      const { ctx } = chart;
      ctx.save(); ctx.font = "700 11.5px Inter, system-ui, sans-serif"; ctx.fillStyle = COLORS.ink; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      totMes.forEach((v,i)=>{
        if(!v) return;
        let topo = Infinity, x = null;
        chart.data.datasets.forEach((ds,di)=>{ const meta = chart.getDatasetMeta(di); if(meta.hidden) return; const b = meta.data[i]; if(b && ds.data[i]){ topo = Math.min(topo, b.y); x = b.x; } });
        if(x!=null) ctx.fillText(fmtTopo(v), x, topo - 5);
      });
      ctx.restore();
    }
  };
  const segmento = { stack:"a", borderColor:"#fff", borderWidth:{ top:2 }, borderSkipped:"bottom", borderRadius:5, maxBarThickness:46 };
  mkChart("ch-manut-mensal", {
    type:"bar",
    data:{ labels:m.labels, datasets:[
      { label:"Manutenção Geral", data:m.manutencaoGeral, backgroundColor:COLORS.red, ...segmento },
      { label:"Pintura do Teto", data:m.pinturaTeto, backgroundColor:COLORS.ink, ...segmento },
      { label:"Outros", data:m.outrosServicos, backgroundColor:COLORS.amber, ...segmento }
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ position:"bottom", labels:{ boxWidth:10, usePointStyle:true, pointStyle:"circle", padding:14 } },
        tooltip:{ mode:"index", filter:(it)=>it.raw>0,
          callbacks:{ title:(its)=>`${its[0].label} — total ${fmtBRL(totMes[its[0].dataIndex])}`, label:(it)=>` ${it.dataset.label}: ${fmtBRL(it.raw)}` } },
        datalabels:{ display:false } },
      layout:{ padding:{ top:22 } },
      scales:{ x:{ stacked:true, grid:{ display:false }, border:{ display:false } },
               y:{ stacked:true, grid:{ color:COLORS.grid }, border:{ display:false }, ticks:{ callback:v=>fmtMil(v), color:COLORS.inkSoft } } } },
    plugins:[totalNoTopo]
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
  const filtro = FILTRO_ANO.diesel;
  const d = dieselView = (filtro === "todos" || DATA.diesel.lancamentos.length === 0)
    ? DATA.diesel
    : computarDieselStats(DATA.diesel.lancamentos.filter(r=>r.d.startsWith(filtro)));
  const maiorMesIdx = d.mensal.indexOf(Math.max(...d.mensal));
  return `
    <div class="page-head"><h2>Diesel</h2><p>Custo de abastecimento — ${d.mensalLabels[0]} a ${d.mensalLabels[d.mensalLabels.length-1]}</p>${montarFiltroAno("diesel", DATA.diesel.lancamentos)}</div>
    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Total do período</div><div class="val">${fmtBRL(d.totalPeriodo)}</div></div>
      <div class="kpi"><div class="lbl">Litros abastecidos</div><div class="val">${d.totalLitrosPeriodo!=null ? fmtNum(Math.round(d.totalLitrosPeriodo))+" <span style=\"font-size:15px; font-weight:700;\">litros</span>" : "—"}</div>${d.totalLitrosPeriodo>=1000 ? `<div class="delta flat">≈ ${fmtNum(Math.round(d.totalLitrosPeriodo/1000))} mil litros</div>` : ""}</div>
      <div class="kpi"><div class="lbl">Custo médio por litro</div><div class="val">${d.custoMedioLitro!=null ? fmtBRL2(d.custoMedioLitro) : "—"}</div></div>
      <div class="kpi"><div class="lbl">Média semanal</div><div class="val">${fmtMil(d.mediaSemanal)}</div></div>
      <div class="kpi"><div class="lbl">Top 10 caminhões</div><div class="val">${d.topCaminhoesTotalPct}%</div><div class="delta flat">do custo total do período</div></div>
      <div class="kpi"><div class="lbl">Maior mês</div><div class="val">${fmtBRL(Math.max(...d.mensal))}</div><div class="delta flat">${d.mensalLabels[maiorMesIdx]}</div></div>
    </div>
    <div class="panel" style="margin-bottom:16px;">
      <h3>Custo mensal (${d.mensalLabels[0]}–${d.mensalLabels[d.mensalLabels.length-1]})</h3>
      <div class="chart-wrap" style="height:280px;"><canvas id="ch-diesel-mensal"></canvas></div>
      <div class="chart-insight">${insightSerie(d.mensalLabels, d.mensal, fmtBRL)}</div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <h3>Custo semanal (R$ mil)</h3>
        <div class="chart-wrap" style="height:260px;"><canvas id="ch-diesel-semanal"></canvas></div>
        <div class="chart-insight">${insightSerie(d.semanalLabels, d.semanal_x1000, v=>fmtNum(Math.round(v))+"K")}</div>
      </div>
      <div class="panel">
        <h3>10 maiores caminhões</h3>
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
  const d = dieselView || DATA.diesel;
  // Média de 2026 pra desenhar como linha de referência por cima das barras — só entra se o recorte
  // atual (Todos/2025/2026) realmente tiver algum mês de 2026 pra calcular em cima.
  const valores2026 = d.mensalLabels.map((l,i)=>l.endsWith("/26") ? d.mensal[i] : null).filter(v=>v!=null);
  const media2026 = valores2026.length ? sumArr(valores2026)/valores2026.length : null;

  const datasetsMensal = [
    { label:"Custo Mensal", data:d.mensal, backgroundColor:d.mensal.map(v=>v===Math.max(...d.mensal)?COLORS.redDark:COLORS.red), borderRadius:5 }
  ];
  if(media2026 != null){
    datasetsMensal.push({
      type:"line", label:`Média 2026 (${fmtBRL2(media2026)})`, data:d.mensalLabels.map(()=>media2026),
      borderColor:COLORS.ink, borderDash:[6,4], borderWidth:2, pointRadius:0, fill:false,
      datalabels:{ display:false }
    });
  }
  mkChart("ch-diesel-mensal", {
    type:"bar",
    data:{ labels:d.mensalLabels, datasets:datasetsMensal },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display: media2026 != null, position:"bottom", labels:{boxWidth:10, usePointStyle:true, pointStyle:"line"}},
        datalabels:{ display:(ctx)=>ctx.datasetIndex===0, anchor:"end", align:"top", offset:2, color:COLORS.ink, font:{size:13, weight:700}, formatter:fmtLabelBRL } },
      layout:{ padding:{ top:22 } },
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
// Média mensal por trimestre de cada categoria da folha no ano escolhido. Cada média usa só os meses
// que já têm valor naquela categoria (mês em aberto não puxa a média para baixo); a seta compara com
// o trimestre anterior (no T1, com o T4 do ano anterior). Para custo, subir é vermelho e cair é verde.
function folhaValorMes(campo, ano, mes){
  const i = filtrarFolhaIndices({ ano:String(ano), mes:String(mes) })[0];
  const v = i==null ? null : DATA.folha[campo][i];
  return v==null || !(v>0) ? null : v;
}
function folhaMediaTri(campo, ano, tri){
  const vals = [1,2,3].map(k=>{
    const mes = (tri-1)*3+k;
    if(campo === "total"){
      const p = ["salario","ad40","vtVr"].map(c=>folhaValorMes(c, ano, mes));
      return p[0]==null ? null : sumArr(p.map(v=>v||0)); // só meses com salário lançado (mês fechado)
    }
    return folhaValorMes(campo, ano, mes);
  }).filter(v=>v!=null);
  return vals.length ? { media: sumArr(vals)/vals.length, total: sumArr(vals), meses: vals.length } : null;
}
function folhaTrimestres(ano){
  if(!ano) return "";
  const cats = [
    { campo:"salario", nome:"Salário",                   cor:COLORS.ink },
    { campo:"ad40",    nome:"40% Adicional",             cor:COLORS.red },
    { campo:"vtVr",    nome:"VT + VR",                   cor:"#E8939E" },
    { campo:"total",   nome:"Total (com VT + VR)",       cor:"#5B5F6B" },
  ];
  const tris = [["T1","jan–mar"],["T2","abr–jun"],["T3","jul–set"],["T4","out–dez"]];
  const seta = (a, b) => {
    if(!a || !b) return `<span class="ftri-p flat">—</span>`;
    const p = (a.media-b.media)/b.media*100;
    if(Math.abs(p) < 0.05) return `<span class="ftri-p flat">→ 0%</span>`;
    return `<span class="ftri-p ${p>0?"up":"down"}" title="vs. trimestre anterior">${p>0?"▲":"▼"} ${Math.abs(p).toFixed(1).replace(".",",")}%</span>`;
  };
  const cards = cats.map(c=>{
    const q = [1,2,3,4].map(t=>folhaMediaTri(c.campo, ano, t));
    const antT4 = folhaMediaTri(c.campo, Number(ano)-1, 4);
    const comDado = q.filter(Boolean);
    const mesesAno = sumArr(comDado.map(x=>x.meses));
    const mediaAno = mesesAno ? sumArr(comDado.map(x=>x.total))/mesesAno : 0;
    return `<div class="ftri-card" style="--c:${c.cor};">
      <div class="ftri-top"><i></i>${c.nome}</div>
      <div class="ftri-val">${mediaAno ? fmtBRL(mediaAno) : "—"}</div>
      <div class="ftri-sub">média mensal em ${ano}${mesesAno ? ` · ${mesesAno} ${mesesAno===1?"mês":"meses"}` : ""}</div>
      ${tris.map(([t,meses],i)=>`<div class="ftri-row ${q[i]?"":"vazio"}">
        <span class="ftri-t"><b>${t}</b> ${meses}</span>
        <span class="ftri-m">${q[i] ? fmtBRL(q[i].media) : "sem dados"}${q[i] && q[i].meses<3 ? `<small> (${q[i].meses} de 3 meses)</small>` : ""}</span>
        ${q[i] ? seta(q[i], i ? q[i-1] : antT4) : `<span class="ftri-p flat"></span>`}
      </div>`).join("")}
    </div>`;
  }).join("");
  return `
    <div class="panel" style="margin-bottom:16px;">
      <h3>Média mensal por trimestre — ${ano}</h3>
      <div class="hint">Quanto é pago, em média, por mês em cada categoria. Seta: comparação com o trimestre anterior (▲ aumento · ▼ queda). Troque o ano no filtro acima.</div>
      <div class="ftri-grid">${cards}</div>
    </div>`;
}

renderers.folha = () => {
  const f = DATA.folha;
  const anosDisponiveis = [...new Set(f.labels.map(l=>"20"+l.slice(-2)))].sort();
  const categoriaLabel = { todos:"Todos", vtVr:"VT + VR", ad40:"40% Adicional", salario:"Salário" };
  const opt = (valor,label,atual) => `<option value="${valor}" ${atual===valor?"selected":""}>${label}</option>`;

  const idxFiltrados = filtrarFolhaIndices(FILTRO_FOLHA);
  const somaCampo = (campo) => sumArr(idxFiltrados.map(i=>f[campo][i]));
  const totalVtVr = somaCampo("vtVr"), totalAd40 = somaCampo("ad40"), totalSalario = somaCampo("salario");
  const totalGeral = totalVtVr + totalAd40 + totalSalario;
  const totalFolha = totalAd40 + totalSalario; // sem o benefício VT+VR — mesma convenção usada no resto do painel

  const totalPeriodoLabel = FILTRO_FOLHA.categoria === "todos" ? "Total do Período (sem VT+VR)" : `Total do Período — ${categoriaLabel[FILTRO_FOLHA.categoria]}`;
  const totalPeriodoValor = FILTRO_FOLHA.categoria === "todos" ? totalFolha : somaCampo(FILTRO_FOLHA.categoria);
  const comparacao = compararFolhaAnoAnterior(FILTRO_FOLHA.ano !== "todos" ? FILTRO_FOLHA.ano : null);

  const composicao = [
    { nome:"Salário", valor:totalSalario, pct: totalGeral ? totalSalario/totalGeral*100 : 0 },
    { nome:"40% Adicional", valor:totalAd40, pct: totalGeral ? totalAd40/totalGeral*100 : 0 },
    { nome:"VT + VR", valor:totalVtVr, pct: totalGeral ? totalVtVr/totalGeral*100 : 0 }
  ];

  // Mesma série (por ano, ignorando o filtro de Mês) que o gráfico principal desenha — replicada aqui
  // só pra gerar a frase de análise, ver initCharts.folha pra a versão que realmente monta o gráfico.
  const idxAnoInsight = FILTRO_FOLHA.ano === "todos" ? f.labels.map((_,i)=>i) : filtrarFolhaIndices({ ano:FILTRO_FOLHA.ano, mes:"todos" });
  const labelsInsight = idxAnoInsight.map(i=>f.labels[i]);
  const valoresInsight = FILTRO_FOLHA.categoria !== "todos"
    ? idxAnoInsight.map(i=>f[FILTRO_FOLHA.categoria][i])
    : idxAnoInsight.map(i=>{
        const vt=f.vtVr[i], ad=f.ad40[i], sal=f.salario[i];
        return (vt==null && ad==null && sal==null) ? null : (vt||0)+(ad||0)+(sal||0);
      });

  return `
    <div class="page-head"><h2>Folha · Benefícios + Salário</h2><p>VT/VR, adicional 40% e salário${f.labels.length ? ` — ${f.labels[0]} a ${f.labels[f.labels.length-1]}` : ""}</p></div>

    <div class="panel" style="margin-bottom:16px;">
      <h3 style="margin-bottom:10px;">Filtros</h3>
      <div class="filtro-bar">
        <label>Ano<select onchange="setFiltroFolha('ano',this.value)">
          ${opt("todos","Todos",FILTRO_FOLHA.ano)}${anosDisponiveis.map(a=>opt(a,a,FILTRO_FOLHA.ano)).join("")}
        </select></label>
        <label>Mês<select onchange="setFiltroFolha('mes',this.value)">
          ${opt("todos","Todos",FILTRO_FOLHA.mes)}${MONTH_ABBR.map((m,i)=>opt(String(i+1), m[0].toUpperCase()+m.slice(1), FILTRO_FOLHA.mes)).join("")}
        </select></label>
        <label>Categoria<select onchange="setFiltroFolha('categoria',this.value)">
          ${opt("todos","Todos",FILTRO_FOLHA.categoria)}${opt("vtVr","VT + VR",FILTRO_FOLHA.categoria)}${opt("ad40","40% Adicional",FILTRO_FOLHA.categoria)}${opt("salario","Salário",FILTRO_FOLHA.categoria)}
        </select></label>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">${totalPeriodoLabel}</div><div class="val">${fmtBRL(totalPeriodoValor)}</div></div>
      <div class="kpi"><div class="lbl">Total de Salário${FILTRO_FOLHA.ano!=="todos" ? ` (${FILTRO_FOLHA.ano})` : ""}</div><div class="val">${fmtBRL(totalSalario)}</div></div>
      <div class="kpi"><div class="lbl">Total VT + VR</div><div class="val">${fmtBRL(totalVtVr)}</div><div class="delta flat">benefício, fora do total da folha</div></div>
      ${comparacao && comparacao.comparavel ? `
      <div class="kpi"><div class="lbl">${comparacao.ano} vs ${comparacao.anoAnterior} (${comparacao.mesesFechados} ${comparacao.mesesFechados===1?"mês":"meses"})</div><div class="val">${comparacao.crescimentoPct>=0?"+":""}${comparacao.crescimentoPct}%</div>${deltaBadge(comparacao.crescimentoPct, true)}</div>` : ""}
    </div>

    ${folhaTrimestres(FILTRO_FOLHA.ano !== "todos" ? FILTRO_FOLHA.ano : anosDisponiveis[anosDisponiveis.length-1])}

    <div class="panel" style="margin-bottom:16px;">
      <h3>Composição mensal do custo (R$)</h3>
      <div class="hint">VT+VR, 40% adicional e salário — linha preta: custo total do mês (com VT+VR)${FILTRO_FOLHA.categoria!=="todos" ? ` · mostrando só "${categoriaLabel[FILTRO_FOLHA.categoria]}"` : ""}. Passe o mouse sobre uma coluna pra ver os valores.</div>
      <div class="chart-wrap" style="height:400px;"><canvas id="ch-folha"></canvas></div>
      <div class="chart-insight">${insightSerie(labelsInsight, valoresInsight, fmtBRL)}</div>
    </div>
    <div class="panel">
      <h3>% de Representação no Período</h3>
      <div class="hint">Cada categoria sobre o custo total (VT+VR + 40% + Salário) nos filtros acima</div>
      <div style="display:flex; flex-wrap:wrap; gap:28px; align-items:center; margin-top:8px;">
        <div class="chart-wrap" style="height:260px; flex:1 1 260px; max-width:340px;"><canvas id="ch-folha-comp"></canvas></div>
        <table style="flex:2 1 320px;">
          <thead><tr><th>Categoria</th><th class="num">Valor</th><th class="num">%</th></tr></thead>
          <tbody>${composicao.map(c=>`<tr><td>${c.nome}</td><td class="num">${fmtBRL2(c.valor)}</td><td class="num">${c.pct.toFixed(1)}%</td></tr>`).join("")}</tbody>
        </table>
      </div>
      <div class="chart-insight">${insightComposicao(composicao, "nome", "valor")}</div>
    </div>
  `;
};
initCharts.folha = () => {
  const f = DATA.folha;
  const idxAno = FILTRO_FOLHA.ano === "todos" ? f.labels.map((_,i)=>i) : filtrarFolhaIndices({ ano:FILTRO_FOLHA.ano, mes:"todos" });
  const labels = idxAno.map(i=>f.labels[i]);
  const categoriaCores = { vtVr:"#F0B9C0", ad40:COLORS.red, salario:COLORS.ink };
  const categoriaNomes = { vtVr:"VT+VR", ad40:"40% Adicional", salario:"Salário" };
  // Com muitos meses na tela (visão "Todos" os anos) o rótulo de cada barra/ponto vira uma pilha
  // ilegível de números um em cima do outro — só mostra os valores fixos quando dá pra ler (~1 ano
  // e meio); do contrário, o valor ainda aparece passando o mouse (tooltip).
  const mostrarRotulos = labels.length <= 18;

  if(FILTRO_FOLHA.categoria === "todos"){
    // A linha precisa acompanhar o TOPO DE VERDADE da barra empilhada (VT+VR + 40% + Salário) —
    // usar só "Total" (que por convenção exclui VT+VR, ver recomputeFolha) faria a linha cair NO
    // MEIO da barra em vários meses, com o rótulo escrito por cima da cor escura da barra e
    // ilegível. Aqui, "Custo Total" é só dessa linha/rótulo — os KPIs continuam usando f.total.
    const custoTotalComBeneficio = idxAno.map(i=>{
      const vt=f.vtVr[i], ad=f.ad40[i], sal=f.salario[i];
      return (vt==null && ad==null && sal==null) ? null : (vt||0)+(ad||0)+(sal||0);
    });
    mkChart("ch-folha", {
      data:{ labels, datasets:[
        { type:"bar", label:"VT+VR", data:idxAno.map(i=>f.vtVr[i]), backgroundColor:"#F0B9C0", stack:"a", borderRadius:2, datalabels:{display:false} },
        { type:"bar", label:"40% Adicional", data:idxAno.map(i=>f.ad40[i]), backgroundColor:COLORS.red, stack:"a", borderRadius:2, datalabels:{display:false} },
        { type:"bar", label:"Salário", data:idxAno.map(i=>f.salario[i]), backgroundColor:COLORS.ink, stack:"a", borderRadius:2, datalabels:{display:false} },
        { type:"line", label:"Custo Total", data:custoTotalComBeneficio, borderColor:"#000", borderWidth:2, pointRadius:3, pointBackgroundColor:"#000", tension:.25, clip:false,
          datalabels:{ display:(ctx)=>mostrarRotulos && ctx.dataset.data[ctx.dataIndex]!=null, align:"top", offset:6, color:COLORS.ink, font:{size:10, weight:700}, formatter:fmtLabelBRL } }
      ]},
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{legend:{position:"bottom", labels:{boxWidth:10, usePointStyle:true, pointStyle:"circle"}},
          tooltip:{ callbacks:{ label:(ctx)=> `${ctx.dataset.label}: ${fmtBRL2(ctx.parsed.y)}` } }},
        layout:{ padding:{ top:34 } },
        scales:{ x:{stacked:true, grid:{display:false}, ticks:{maxRotation:60, minRotation:60}},
          y:{stacked:true, grid:{color:COLORS.grid}, ticks:{callback:v=>fmtMil(v)}, suggestedMax: Math.max(0, ...custoTotalComBeneficio.map(v=>v||0))*1.12 } } }
    });
  } else {
    const campo = FILTRO_FOLHA.categoria;
    mkChart("ch-folha", {
      type:"bar",
      data:{ labels, datasets:[{ label:categoriaNomes[campo], data:idxAno.map(i=>f[campo][i]), backgroundColor:categoriaCores[campo], borderRadius:3, clip:false }]},
      options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
          tooltip:{ callbacks:{ label:(ctx)=> `${ctx.dataset.label}: ${fmtBRL2(ctx.parsed.y)}` } },
          datalabels:{ display:(ctx)=>mostrarRotulos && ctx.dataset.data[ctx.dataIndex]!=null, anchor:"end", align:"top", offset:2, color:COLORS.ink, font:{size:10, weight:700}, formatter:fmtLabelBRL } },
        layout:{ padding:{ top:24 } },
        scales:{ y:{grid:{color:COLORS.grid}, ticks:{callback:v=>fmtMil(v)}, suggestedMax: Math.max(0, ...idxAno.map(i=>f[campo][i]||0))*1.12 }, x:{grid:{display:false}, ticks:{maxRotation:60, minRotation:60}} } }
    });
  }

  // Composição do período filtrado (Ano/Mês) — a Categoria não entra aqui, já que o objetivo do
  // gráfico é comparar as 3 categorias entre si.
  const idxFiltrados = filtrarFolhaIndices(FILTRO_FOLHA);
  const somaCampo = (campo) => sumArr(idxFiltrados.map(i=>f[campo][i]));
  const compData = [somaCampo("salario"), somaCampo("ad40"), somaCampo("vtVr")];
  const compTotal = sumArr(compData);
  mkChart("ch-folha-comp", {
    type:"doughnut",
    data:{ labels:["Salário","40% Adicional","VT + VR"], datasets:[{ data:compData, backgroundColor:[COLORS.ink, COLORS.red, "#F0B9C0"], borderWidth:2, borderColor:"#fff" }]},
    options:{ responsive:true, maintainAspectRatio:false, cutout:"60%",
      plugins:{legend:{position:"bottom", labels:{boxWidth:10, font:{size:10}, usePointStyle:true, pointStyle:"circle"}},
        datalabels:{ display:(ctx)=>compTotal>0 && ctx.dataset.data[ctx.dataIndex]/compTotal>0.02, color:"#fff", font:{size:10, weight:700},
          formatter:(v)=> compTotal? (v/compTotal*100).toFixed(1)+"%" : "" } } }
  });
};

/* -------------------- HORA EXTRA --------------------
   Tudo é calculado a partir de DATA.horaExtra.lancamentos (uma linha por colaborador e mês, em R$),
   importados da planilha de Hora Extra. Filtros de Ano, Mês e Função valem para a página inteira;
   as comparações são sempre contra o MESMO período do ano anterior (ex: jan–set/26 x jan–set/25). */
const MESES_HE = ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];
const FILTRO_HE = { ano:null, mes:"todos", funcao:"todas" };

window.setFiltroHE = (campo, valor) => { FILTRO_HE[campo] = valor; navigate("horaextra"); };

function heLanc(){ return (DATA.horaExtra && DATA.horaExtra.lancamentos) || []; }
function heAnos(){ return [...new Set(heLanc().map(r=>r.mes.slice(0,4)))].sort(); }
function heMesNum(r){ return parseInt(r.mes.slice(5,7), 10); }

// Seta + % de variação. Para custo, subir é ruim (vermelho) e cair é bom (verde).
function heSeta(atual, anterior, sufixo){
  if(!anterior) return `<span class="delta flat">— sem base de comparação</span>`;
  const pct = (atual - anterior) / anterior * 100;
  if(Math.abs(pct) < 0.05) return `<span class="delta flat">→ 0% ${sufixo||""}</span>`;
  return `<span class="delta ${pct>0?"up":"down"}">${pct>0?"▲":"▼"} ${Math.abs(pct).toFixed(1)}% ${sufixo||""}</span>`;
}
function heSetaMini(atual, anterior){
  if(!anterior || !atual) return "";
  const pct = (atual - anterior) / anterior * 100;
  if(Math.abs(pct) < 0.5) return `<span class="he-seta flat">→</span>`;
  return `<span class="he-seta ${pct>0?"up":"down"}" title="${pct>0?"+":""}${pct.toFixed(1)}% vs. mês anterior">${pct>0?"▲":"▼"}</span>`;
}

function heAgrupar(linhas, chaveFn){
  const m = {};
  linhas.forEach(r=>{ const k = chaveFn(r); m[k] = (m[k]||0) + (r.total||0); });
  return m;
}

// Estatísticas do período filtrado + mesmo período do ano anterior
function heStats(){
  const anos = heAnos();
  if(!FILTRO_HE.ano || !anos.includes(FILTRO_HE.ano)) FILTRO_HE.ano = anos[anos.length-1];
  const ano = FILTRO_HE.ano, anoAnt = String(Number(ano)-1);
  const porFuncao = heLanc().filter(r=>FILTRO_HE.funcao==="todas" || r.funcao===FILTRO_HE.funcao);
  const doAno = porFuncao.filter(r=>r.mes.startsWith(ano));
  const mesesComDado = [...new Set(doAno.map(heMesNum))].sort((a,b)=>a-b);
  const meses = FILTRO_HE.mes==="todos" ? mesesComDado : [Number(FILTRO_HE.mes)];
  const noPeriodo = (r, a) => r.mes.startsWith(a) && meses.includes(heMesNum(r));
  const atual = porFuncao.filter(r=>noPeriodo(r, ano) && r.total);
  const anterior = porFuncao.filter(r=>noPeriodo(r, anoAnt) && r.total);

  const resumo = (linhas) => {
    const total = sumArr(linhas.map(r=>r.total));
    const porColab = heAgrupar(linhas, r=>r.colaborador);
    const ranking = Object.entries(porColab).map(([nome,valor])=>({ nome, valor })).sort((a,b)=>b.valor-a.valor);
    const nMeses = new Set(linhas.map(r=>r.mes)).size;
    return { total, ranking, colabs:ranking.length, nMeses, mediaMensal: nMeses ? total/nMeses : 0,
             porColabMedia: ranking.length ? total/ranking.length : 0,
             top10Pct: total ? sumArr(ranking.slice(0,10).map(r=>r.valor))/total*100 : 0 };
  };
  const funcaoDe = {};
  heLanc().forEach(r=>{ if(r.funcao) funcaoDe[r.colaborador] = r.funcao; });
  return { ano, anoAnt, meses, mesesComDado, porFuncao, atual, anterior, A:resumo(atual), B:resumo(anterior), funcaoDe };
}

// Alertas de RH — olham a série completa, independentes do filtro de mês
function heAlertas(porFuncao){
  const mesesTodos = [...new Set(porFuncao.map(r=>r.mes))].sort();
  if(!mesesTodos.length) return [];
  const ultimo = mesesTodos[mesesTodos.length-1];
  const ult12 = mesesTodos.slice(-12), ant3 = mesesTodos.slice(-4, -1);
  const porColabMes = {};
  porFuncao.forEach(r=>{ if(!r.total) return; (porColabMes[r.colaborador] = porColabMes[r.colaborador] || {})[r.mes] = (porColabMes[r.colaborador][r.mes]||0) + r.total; });
  const nomeMes = (m) => `${MESES_HE[parseInt(m.slice(5),10)-1]}/${m.slice(2,4)}`;

  const recorrentes = Object.entries(porColabMes)
    .map(([nome, ms])=>({ nome, n: ult12.filter(m=>ms[m]).length, total: sumArr(ult12.map(m=>ms[m]||0)) }))
    .filter(x=>x.n >= Math.min(10, ult12.length)).sort((a,b)=>b.total-a.total);

  const bruscos = Object.entries(porColabMes).map(([nome, ms])=>{
    const media = ant3.length ? sumArr(ant3.map(m=>ms[m]||0))/ant3.length : 0;
    return { nome, atual: ms[ultimo]||0, media };
  }).filter(x=>x.media>0 && x.atual >= 500 && x.atual > x.media*1.5).sort((a,b)=>(b.atual/b.media)-(a.atual/a.media));

  const doUltimo = Object.entries(porColabMes).map(([nome, ms])=>({ nome, v: ms[ultimo]||0 })).filter(x=>x.v);
  const mediaUlt = doUltimo.length ? sumArr(doUltimo.map(x=>x.v))/doUltimo.length : 0;
  const acima = doUltimo.filter(x=>x.v > mediaUlt*2).sort((a,b)=>b.v-a.v);

  const totUlt = sumArr(doUltimo.map(x=>x.v));
  const top10Ult = sumArr([...doUltimo].sort((a,b)=>b.v-a.v).slice(0,10).map(x=>x.v));
  const concPct = totUlt ? top10Ult/totUlt*100 : 0;

  const lista = (itens, fmt) => itens.length
    ? `<ul class="he-alerta-lista">${itens.slice(0,8).map(fmt).join("")}${itens.length>8?`<li class="mais">+ ${itens.length-8} colaborador(es)</li>`:""}</ul>`
    : `<div class="hint" style="margin:0;">Nenhum caso. ✓</div>`;
  return [
    { cor:"red", titulo:"Hora extra recorrente", desc:`HE em ${Math.min(10, ult12.length)} ou mais dos últimos ${ult12.length} meses`, qtd:recorrentes.length,
      corpo: lista(recorrentes, x=>`<li><b>${x.nome}</b><span>${x.n} de ${ult12.length} meses · ${fmtBRL(x.total)}</span></li>`) },
    { cor:"amber", titulo:"Aumento brusco", desc:`${nomeMes(ultimo)} mais de 50% acima da média dos 3 meses anteriores`, qtd:bruscos.length,
      corpo: lista(bruscos, x=>`<li><b>${x.nome}</b><span>${fmtBRL(x.atual)} · média ${fmtBRL(x.media)} (▲ ${((x.atual/x.media-1)*100).toFixed(0)}%)</span></li>`) },
    { cor:"amber", titulo:"Custo acima do dobro da média", desc:`${nomeMes(ultimo)} · média por colaborador: ${fmtBRL(mediaUlt)}`, qtd:acima.length,
      corpo: lista(acima, x=>`<li><b>${x.nome}</b><span>${fmtBRL(x.v)}</span></li>`) },
    { cor: concPct>30 ? "red" : "green", titulo:"Concentração nos 10 maiores", desc:`${nomeMes(ultimo)} · referência de alerta: acima de 30%`, qtd:`${concPct.toFixed(0)}%`,
      corpo: `<div class="hint" style="margin:0;">Os 10 colaboradores com mais HE somam <b>${fmtBRL(top10Ult)}</b> de ${fmtBRL(totUlt)} no mês.</div>` },
  ];
}

renderers.horaextra = () => {
  const lanc = heLanc();
  if(!lanc.length){
    return `<div class="page-head"><h2>Hora Extra</h2></div>
      <div class="panel"><div class="empty-state" style="padding:24px;"><div class="glyph">⏱️</div><h4>Nenhum dado de hora extra</h4>
      <p>Vá em <b>Entrada de Dados → Hora Extra</b> e importe a planilha "Controle de Hora Extra".</p></div></div>`;
  }
  const st = heStats(), { A, B, ano, anoAnt } = st;
  const funcoes = [...new Set(lanc.map(r=>r.funcao).filter(Boolean))].sort();
  const opt = (v,l,atual) => `<option value="${v}" ${String(atual)===String(v)?"selected":""}>${l}</option>`;
  const periodoTxt = FILTRO_HE.mes==="todos"
    ? (st.meses.length ? `${MESES_HE[st.meses[0]-1]}–${MESES_HE[st.meses[st.meses.length-1]-1]}/${ano.slice(2)}` : ano)
    : `${MESES_HE[Number(FILTRO_HE.mes)-1]}/${ano.slice(2)}`;
  const periodoAnt = periodoTxt.replace(`/${ano.slice(2)}`, `/${anoAnt.slice(2)}`);
  const maior = A.ranking[0];
  const recorrentesAno = (() => {
    const porColab = {};
    st.porFuncao.filter(r=>r.mes.startsWith(ano) && r.total).forEach(r=>{ (porColab[r.colaborador] = porColab[r.colaborador] || new Set()).add(r.mes); });
    const minimo = Math.max(3, Math.ceil(st.mesesComDado.length*0.75));
    return Object.values(porColab).filter(s=>s.size>=minimo).length;
  })();

  // Faixa mês a mês do ano selecionado (seta vs. mês anterior)
  const mensal = heAgrupar(st.porFuncao, r=>r.mes);
  const faixa = st.mesesComDado.map(m=>{
    const k = `${ano}-${String(m).padStart(2,"0")}`;
    const kAnt = m===1 ? `${anoAnt}-12` : `${ano}-${String(m-1).padStart(2,"0")}`;
    const v = mensal[k]||0, vAnt = mensal[kAnt]||0;
    const pct = vAnt ? (v-vAnt)/vAnt*100 : null;
    return `<div class="he-faixa-item ${FILTRO_HE.mes==String(m)?"sel":""}" onclick="setFiltroHE('mes','${FILTRO_HE.mes==String(m)?"todos":m}')">
      <span class="m">${MESES_HE[m-1]}</span><b>${fmtMil(v)}</b>
      ${pct==null ? `<span class="p flat">—</span>` : `<span class="p ${pct>0?"up":"down"}">${pct>0?"▲":"▼"} ${Math.abs(pct).toFixed(0)}%</span>`}
    </div>`;
  }).join("");

  // Ranking (Pareto) do período
  let acum = 0;
  const antPorColab = Object.fromEntries(B.ranking.map(r=>[r.nome, r.valor]));
  const ranking = A.ranking.slice(0,10).map((r,i)=>{
    acum += r.valor;
    return `<tr><td class="rank">${i+1}</td><td><b>${r.nome}</b></td><td>${st.funcaoDe[r.nome]||"—"}</td>
      <td class="num"><b>${fmtBRL2(r.valor)}</b></td><td class="num">${A.total?(r.valor/A.total*100).toFixed(1):0}%</td>
      <td class="num">${A.total?(acum/A.total*100).toFixed(1):0}%</td>
      <td class="num">${antPorColab[r.nome] ? heSeta(r.valor, antPorColab[r.nome]).replace('class="delta','class="delta sm') : '<span class="delta flat sm">novo</span>'}</td></tr>`;
  }).join("");

  // Maiores por mês (top 10 do ano × meses)
  const doAno = st.porFuncao.filter(r=>r.mes.startsWith(ano) && r.total);
  const matriz = {};
  doAno.forEach(r=>{ const m = heMesNum(r); (matriz[r.colaborador] = matriz[r.colaborador] || {})[m] = (matriz[r.colaborador][m]||0) + r.total; });
  const top10Ano = Object.entries(matriz).map(([nome, ms])=>({ nome, ms, total:sumArr(Object.values(ms)) })).sort((a,b)=>b.total-a.total).slice(0,10);
  const maxMes = {};
  st.mesesComDado.forEach(m=>{ maxMes[m] = Math.max(...Object.values(matriz).map(ms=>ms[m]||0)); });
  const liderMes = st.mesesComDado.map(m=>{
    const lider = Object.entries(matriz).sort((a,b)=>(b[1][m]||0)-(a[1][m]||0))[0];
    return `<td class="num he-lider">${lider ? `${lider[0].split(" ")[0]}<br><b>${fmtBRL(lider[1][m]||0)}</b>` : "—"}</td>`;
  }).join("");

  // Por função (sempre todas as funções, no período)
  const todasNoPeriodo = lanc.filter(r=>r.mes.startsWith(ano) && st.meses.includes(heMesNum(r)) && r.total);
  const todasAnt = lanc.filter(r=>r.mes.startsWith(anoAnt) && st.meses.includes(heMesNum(r)) && r.total);
  const totFuncao = sumArr(todasNoPeriodo.map(r=>r.total));
  const porFuncaoArr = funcoes.map(f=>{
    const ls = todasNoPeriodo.filter(r=>r.funcao===f);
    const colabs = new Set(ls.map(r=>r.colaborador)).size;
    const v = sumArr(ls.map(r=>r.total)), vAnt = sumArr(todasAnt.filter(r=>r.funcao===f).map(r=>r.total));
    return { funcao:f, colabs, v, vAnt };
  }).filter(x=>x.v || x.vAnt).sort((a,b)=>b.v-a.v);
  DATA.horaExtra._porFuncao = porFuncaoArr;

  return `
    <div class="page-head"><h2>Hora Extra</h2><p>Custo em R$ por colaborador, mês e função — ${fmtNum(lanc.length)} lançamento(s) importados</p></div>

    <div class="panel" style="margin-bottom:16px;">
      <div class="filtro-bar">
        <label>Ano<select onchange="setFiltroHE('ano',this.value)">${heAnos().map(a=>opt(a,a,ano)).join("")}</select></label>
        <label>Mês<select onchange="setFiltroHE('mes',this.value)">${opt("todos","Todos os meses",FILTRO_HE.mes)}${st.mesesComDado.map(m=>opt(m, MESES_HE[m-1][0].toUpperCase()+MESES_HE[m-1].slice(1), FILTRO_HE.mes)).join("")}</select></label>
        <label>Função<select onchange="setFiltroHE('funcao',this.value)">${opt("todas","Todas",FILTRO_HE.funcao)}${funcoes.map(f=>opt(f,f,FILTRO_HE.funcao)).join("")}</select></label>
      </div>
      <div class="hint" style="margin:10px 0 0;">Período: <b>${periodoTxt}</b> · comparado com <b>${periodoAnt}</b>${FILTRO_HE.funcao!=="todas" ? ` · função <b>${FILTRO_HE.funcao}</b>` : ""}</div>
    </div>

    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">💰 Custo total de HE</div><div class="val">${fmtBRL(A.total)}</div>${heSeta(A.total, B.total, `vs. ${periodoAnt}`)}</div>
      <div class="kpi"><div class="lbl">👥 Colaboradores com HE</div><div class="val">${A.colabs}</div>${heSeta(A.colabs, B.colabs, `vs. ${periodoAnt}`)}</div>
      <div class="kpi"><div class="lbl">🏆 Maior custo individual</div><div class="val">${maior ? fmtBRL(maior.valor) : "—"}</div><div class="delta flat">${maior ? maior.nome : ""}</div></div>
      <div class="kpi"><div class="lbl">📈 Média mensal de HE</div><div class="val">${fmtBRL(A.mediaMensal)}</div>${heSeta(A.mediaMensal, B.mediaMensal, `vs. ${anoAnt}`)}</div>
      <div class="kpi"><div class="lbl">📊 HE x ano anterior</div><div class="val" style="color:var(--${A.total>B.total?"red":"green"});">${B.total ? `${A.total>B.total?"▲":"▼"} ${Math.abs((A.total-B.total)/B.total*100).toFixed(1)}%` : "—"}</div><div class="delta flat">${B.total ? `${A.total>B.total?"+":"−"}${fmtBRL(Math.abs(A.total-B.total))}` : "sem dados do ano anterior"}</div></div>
      <div class="kpi"><div class="lbl">🔴 Funcionários recorrentes</div><div class="val">${recorrentesAno}</div><div class="delta flat">com HE em 75%+ dos meses de ${ano}</div></div>
      <div class="kpi"><div class="lbl">⚠️ Concentração</div><div class="val" style="color:var(--${A.top10Pct>30?"red":"ink"});">${A.top10Pct.toFixed(1)}%</div><div class="delta flat">do custo nos 10 maiores</div></div>
      <div class="kpi"><div class="lbl">🧮 Custo por colaborador</div><div class="val">${fmtBRL(A.porColabMedia)}</div>${heSeta(A.porColabMedia, B.porColabMedia, `vs. ${periodoAnt}`)}</div>
    </div>

    <div class="panel" style="margin-bottom:16px;">
      <h3>Evolução mensal — ${anoAnt} x ${ano}</h3>
      <div class="hint">A seta em cada ponto de ${ano} compara com o mesmo mês de ${anoAnt}: <span style="color:var(--red-dark);">▲ aumento</span> · <span style="color:var(--green);">▼ queda</span></div>
      <div class="chart-wrap" style="height:300px;"><canvas id="ch-he-evolucao"></canvas></div>
      <div class="he-faixa-tit">Mês a mês em ${ano} — seta compara com o mês anterior (clique para filtrar)</div>
      <div class="he-faixa">${faixa}</div>
    </div>

    <div class="grid-2">
      <div class="panel">
        <h3>Top 10 maiores geradores de HE — ${periodoTxt}</h3>
        <div class="hint">Pareto: % acumulado mostra quanto do custo total os primeiros concentram</div>
        <table>
          <thead><tr><th>#</th><th>Colaborador</th><th>Função</th><th class="num">HE (R$)</th><th class="num">% total</th><th class="num">% acum.</th><th class="num">vs. ${anoAnt}</th></tr></thead>
          <tbody>${ranking || `<tr><td colspan="7">Sem dados no período.</td></tr>`}</tbody>
        </table>
      </div>
      <div class="panel">
        <h3>Custo de HE por função — ${periodoTxt}</h3>
        <div class="chart-wrap" style="height:${Math.max(160, porFuncaoArr.length*44)}px;"><canvas id="ch-he-funcao"></canvas></div>
        <div style="overflow-x:auto;"><table style="margin-top:10px;">
          <thead><tr><th>Função</th><th class="num">Colab.</th><th class="num">Total</th><th class="num">%</th><th class="num">Média/colab.</th><th class="num">vs. ${anoAnt}</th></tr></thead>
          <tbody>${porFuncaoArr.map(f=>`<tr><td><b>${f.funcao}</b></td><td class="num">${f.colabs}</td><td class="num">${fmtBRL(f.v)}</td>
            <td class="num">${totFuncao?(f.v/totFuncao*100).toFixed(1):0}%</td><td class="num">${f.colabs?fmtBRL(f.v/f.colabs):"—"}</td>
            <td class="num">${heSeta(f.v, f.vAnt).replace('class="delta','class="delta sm')}</td></tr>`).join("")}</tbody>
        </table></div>
      </div>
    </div>

    <div class="panel" style="margin:16px 0;">
      <h3>Maiores por mês em ${ano} (R$)</h3>
      <div class="hint">Os 10 colaboradores com mais HE no ano. Em vermelho, o maior valor de cada mês; a seta compara com o mês anterior do próprio colaborador.</div>
      <div style="overflow-x:auto;">
      <table class="he-matriz">
        <thead><tr><th>#</th><th>Colaborador</th>${st.mesesComDado.map(m=>`<th class="num">${MESES_HE[m-1]}</th>`).join("")}<th class="num">Total</th></tr></thead>
        <tbody>
          <tr class="he-lider-row"><td></td><td><b>Maior do mês</b></td>${liderMes}<td></td></tr>
          ${top10Ano.map((t,i)=>`<tr><td class="rank">${i+1}</td><td><b>${t.nome}</b><div class="hint" style="margin:0;">${st.funcaoDe[t.nome]||""}</div></td>
            ${st.mesesComDado.map((m,j)=>{ const v = t.ms[m]||0, vAnt = j>0 ? (t.ms[st.mesesComDado[j-1]]||0) : 0;
              return `<td class="num ${v && v===maxMes[m]?"he-max":""}">${v ? fmtBRL(v) : "—"} ${j>0?heSetaMini(v, vAnt):""}</td>`; }).join("")}
            <td class="num"><b>${fmtBRL(t.total)}</b></td></tr>`).join("")}
        </tbody>
      </table>
      </div>
    </div>

    <div class="grid-2">
      <div class="panel">
        <h3>Composição do custo — ${periodoTxt}</h3>
        <div class="hint">Quanto de cada tipo de hora extra compõe o total</div>
        <div class="chart-wrap" style="height:240px;"><canvas id="ch-he-tipo"></canvas></div>
      </div>
      <div class="panel">
        <h3>🚨 Alertas de RH</h3>
        <div class="hint">Calculados sobre o último mês com dados${FILTRO_HE.funcao!=="todas" ? ` · função ${FILTRO_HE.funcao}` : ""}</div>
        <div class="he-alertas">
          ${heAlertas(st.porFuncao).map(a=>`<div class="he-alerta ${a.cor}">
            <div class="he-alerta-top"><b>${a.titulo}</b><span class="he-alerta-qtd">${a.qtd}</span></div>
            <div class="hint" style="margin:2px 0 6px;">${a.desc}</div>${a.corpo}</div>`).join("")}
        </div>
      </div>
    </div>

    <div class="panel" style="margin-top:16px;">
      <h3>Quantidade de horas extras — 2025 x 2026</h3>
      <div class="hint">Lançamento manual mensal (Entrada de Dados → Hora Extra → Quantidade). A planilha de R$ não traz horas.</div>
      <div class="chart-wrap" style="height:240px;"><canvas id="ch-he-qtd"></canvas></div>
    </div>`;
};

initCharts.horaextra = () => {
  if(!heLanc().length) return;
  const st = heStats(), { ano, anoAnt } = st;
  const mensal = heAgrupar(st.porFuncao, r=>r.mes);
  const serie = (a) => MESES_HE.map((_,i)=>{ const v = mensal[`${a}-${String(i+1).padStart(2,"0")}`]; return v ? Math.round(v) : null; });
  const sAtual = serie(ano), sAnt = serie(anoAnt);
  const varPct = (i) => (sAtual[i]!=null && sAnt[i]) ? (sAtual[i]-sAnt[i])/sAnt[i]*100 : null;

  mkChart("ch-he-evolucao", {
    type:"line",
    data:{ labels:MESES_HE, datasets:[
      { label:anoAnt, data:sAnt, borderColor:"#B9BBC6", backgroundColor:"#B9BBC6", borderWidth:2, pointRadius:3, tension:.3,
        datalabels:{ display:false } },
      { label:ano, data:sAtual, borderColor:COLORS.red, backgroundColor:COLORS.red, borderWidth:3, pointRadius:4, tension:.3,
        datalabels:{
          display:(ctx)=>sAtual[ctx.dataIndex]!=null,
          align:"top", anchor:"end", offset:4, font:{ size:9, weight:700 },
          color:(ctx)=>{ const p = varPct(ctx.dataIndex); return p==null ? COLORS.ink : p>0 ? COLORS.red : COLORS.green; },
          formatter:(v,ctx)=>{ const p = varPct(ctx.dataIndex); return `${fmtMil(v)}${p==null ? "" : `\n${p>0?"▲":"▼"} ${Math.abs(p).toFixed(0)}%`}`; }
        } }
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ position:"bottom", labels:{ boxWidth:10, usePointStyle:true, pointStyle:"circle" } },
        tooltip:{ callbacks:{ label:(ctx)=>`${ctx.dataset.label}: ${fmtBRL(ctx.parsed.y)}`,
          afterLabel:(ctx)=>{ if(ctx.datasetIndex!==1) return ""; const p = varPct(ctx.dataIndex); return p==null ? "" : `${p>0?"▲":"▼"} ${Math.abs(p).toFixed(1)}% vs. ${anoAnt}`; } } } },
      layout:{ padding:{ top:30, right:10 } },
      scales:{ y:{ grid:{ color:COLORS.grid }, ticks:{ callback:v=>fmtMil(v) }, beginAtZero:true }, x:{ grid:{ display:false } } } }
  });

  const pf = DATA.horaExtra._porFuncao || [];
  mkChart("ch-he-funcao", {
    type:"bar",
    data:{ labels:pf.map(f=>f.funcao), datasets:[{ label:ano, data:pf.map(f=>Math.round(f.v)), backgroundColor:COLORS.red, borderRadius:4 }] },
    options:{ indexAxis:"y", responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ display:false },
        datalabels:{ anchor:"end", align:"end", color:COLORS.ink, font:{ size:10, weight:700 },
          formatter:(v,ctx)=>{ const f = pf[ctx.dataIndex]; const p = f.vAnt ? (f.v-f.vAnt)/f.vAnt*100 : null; return `${fmtMil(v)}${p==null?"":`  ${p>0?"▲":"▼"}${Math.abs(p).toFixed(0)}%`}`; } } },
      layout:{ padding:{ right:80 } },
      scales:{ x:{ grid:{ color:COLORS.grid }, ticks:{ callback:v=>fmtMil(v) } }, y:{ grid:{ display:false } } } }
  });

  const hq = DATA.horaExtraQtd;
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

  const tipos = [["H.E 20%","he20"],["H.E 50%","he50"],["H.E 100%","he100"],["Dissídio","dissidio"]]
    .map(([l,k])=>({ l, v: sumArr(st.atual.map(r=>r[k]||0)) })).filter(t=>t.v>0);
  const totTipos = sumArr(tipos.map(t=>t.v));
  mkChart("ch-he-tipo", {
    type:"doughnut",
    data:{ labels:tipos.map(t=>t.l), datasets:[{ data:tipos.map(t=>Math.round(t.v)), backgroundColor:[COLORS.amber, COLORS.red, COLORS.redDark, COLORS.inkSoft], borderWidth:2 }] },
    options:{ responsive:true, maintainAspectRatio:false, cutout:"58%",
      plugins:{ legend:{ position:"right", labels:{ boxWidth:10, usePointStyle:true, pointStyle:"circle",
          generateLabels:(chart)=>chart.data.labels.map((l,i)=>({ text:`${l} — ${fmtBRL(chart.data.datasets[0].data[i])}`, fillStyle:chart.data.datasets[0].backgroundColor[i], strokeStyle:"#fff", index:i })) } },
        datalabels:{ color:"#fff", font:{ size:11, weight:700 }, formatter:(v)=>totTipos ? `${(v/totTipos*100).toFixed(0)}%` : "" } } }
  });
};

// Mantém DATA.horaExtraCusto (usado no Painel Executivo) em sincronia com os lançamentos importados
function deriveHoraExtra(){
  const lanc = heLanc();
  if(!lanc.length) return;
  const he = DATA.horaExtraCusto;
  const mensal = heAgrupar(lanc, r=>r.mes);
  ["2025","2026"].forEach(a=>{
    he[`y${a}`] = MESES_HE.map((_,i)=>{ const v = mensal[`${a}-${String(i+1).padStart(2,"0")}`]; return v ? Math.round(v) : null; });
  });
  recomputeHoraExtraCusto();
}
deriveHoraExtra();

/* -------------------- COMPRAS DE PEÇAS -------------------- */
renderers.compras = () => {
  const filtro = FILTRO_ANO.compras;
  const c = comprasView = (filtro === "todos" || DATA.compras.comprasLancamentos.length === 0)
    ? DATA.compras
    : computarComprasStats(DATA.compras.comprasLancamentos.filter(r=>r.d.startsWith(filtro)));
  const recentes = [...c.comprasLancamentos].sort((a,b)=> b.d.localeCompare(a.d)).slice(0,12);
  return `
    <div class="page-head"><h2>Compras de Peças</h2><p>Custo mensal, por categoria e por local — calculado a partir de ${fmtNum(c.comprasLancamentos.length)} lançamentos individuais</p>${montarFiltroAno("compras", DATA.compras.comprasLancamentos)}</div>
    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Total do período</div><div class="val">${fmtBRL(c.totalPeriodo)}</div></div>
      <div class="kpi"><div class="lbl">Top 10 veículos</div><div class="val">${c.top10CaminhoesPct}%</div><div class="delta flat">do custo total</div></div>
      <div class="kpi"><div class="lbl">Maior mês</div><div class="val">${fmtBRL(Math.max(...c.mensal))}</div><div class="delta flat">${c.mensalLabels[c.mensal.indexOf(Math.max(...c.mensal))]}</div></div>
      <div class="kpi"><div class="lbl">Top 10 locais</div><div class="val">${fmtBRL(c.topLocaisTotal)}</div></div>
    </div>
    <div class="panel" style="margin-bottom:16px;">
      <h3>Custo mensal (R$)</h3>
      <div class="chart-wrap" style="height:280px;"><canvas id="ch-compras-mensal"></canvas></div>
      <div class="chart-insight">${insightSerie(c.mensalLabels, c.mensal, fmtBRL)}</div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <h3>Custo por categoria</h3>
        <div class="hint">Total acumulado de todos os lançamentos</div>
        <div class="chart-wrap" style="height:260px;"><canvas id="ch-compras-cat"></canvas></div>
        <div class="chart-insight">${insightRanking(c.porCategoria, "categoria", "valor", fmtBRL2)}</div>
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
  const c = comprasView || DATA.compras;
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
  const temLancamentos = at.lancamentos && at.lancamentos.length > 0;

  // Sem nenhum lançamento importado ainda, mostra o retrato antigo (agregado do data.js) pra a tela
  // não ficar vazia, mas convidando a importar a planilha nova, que é o que destrava tudo.
  if(!temLancamentos){
    return `
    <div class="page-head"><h2>Atestados</h2><p>Ocorrências por período, colaborador e motivo</p></div>
    <div class="panel">
      <div class="empty-state" style="padding:24px;"><div class="glyph">🩺</div>
        <h4>Importe a planilha de atestados pra liberar o painel completo</h4>
        <p>Vá em <b>Entrada de Dados → Atestados</b> e importe o <b>Controle de Atestados/Afastamentos</b>
        (aba LANÇAMENTOS). Com ela vêm dias e horas perdidas, categorias de motivo e os filtros de ano e mês.</p>
      </div>
    </div>`;
  }

  const anosDisponiveis = [...new Set(at.lancamentos.map(i=>i.d.slice(0,4)))].sort();
  const opt = (valor,label,atual) => `<option value="${valor}" ${atual===valor?"selected":""}>${label}</option>`;

  const itens = filtrarAtestados(at.lancamentos, FILTRO_ATESTADOS);
  const st = computarAtestadosStats(itens);
  // A evolução mensal ignora o filtro de Mês de propósito — ela existe pra comparar os meses entre si.
  const stMensal = computarAtestadosStats(filtrarAtestados(at.lancamentos, FILTRO_ATESTADOS, true));

  const maiorAfastamento = itens.reduce((a,b)=> (b.dias||0) > (a.dias||0) ? b : a, itens[0]);

  return `
    <div class="page-head"><h2>Atestados</h2><p>Afastamentos por período, colaborador e motivo · ${fmtNum(at.lancamentos.length)} ocorrência(s) registrada(s)</p></div>

    <div class="panel" style="margin-bottom:16px;">
      <h3 style="margin-bottom:10px;">Filtros</h3>
      <div class="filtro-bar">
        <label>Ano<select onchange="setFiltroAtestados('ano',this.value)">
          ${opt("todos","Todos",FILTRO_ATESTADOS.ano)}${anosDisponiveis.map(a=>opt(a,a,FILTRO_ATESTADOS.ano)).join("")}
        </select></label>
        <label>Mês<select onchange="setFiltroAtestados('mes',this.value)">
          ${opt("todos","Todos",FILTRO_ATESTADOS.mes)}${MONTH_ABBR.map((m,i)=>opt(String(i+1), m[0].toUpperCase()+m.slice(1), FILTRO_ATESTADOS.mes)).join("")}
        </select></label>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Atestados</div><div class="val">${fmtNum(st.totalAtestados)}</div></div>
      <div class="kpi"><div class="lbl">Dias Perdidos</div><div class="val">${fmtNum(st.totalDias)}</div><div class="delta flat">${fmtNum(st.mediaDiasPorColaborador)} dias por colaborador</div></div>
      <div class="kpi"><div class="lbl">Horas Perdidas</div><div class="val">${fmtNum(st.totalHoras)}</div><div class="delta flat">inclui comparecimentos/consultas</div></div>
      <div class="kpi"><div class="lbl">Colaboradores</div><div class="val">${fmtNum(st.colaboradoresDistintos)}</div><div class="delta flat">com atestado no período</div></div>
      <div class="kpi"><div class="lbl">Média Dias / Atestado</div><div class="val">${fmtNum(st.mediaDiasPorAtestado)}</div>${maiorAfastamento ? `<div class="delta flat">Maior: ${fmtNum(maiorAfastamento.dias)} dias</div>` : ""}</div>
    </div>

    <div class="panel" style="margin-bottom:16px;">
      <h3>Evolução mensal — atestados e dias perdidos</h3>
      <div class="hint">Ignora o filtro de Mês acima — mostra o ano inteiro pra dar contexto</div>
      <div class="chart-wrap" style="height:300px;"><canvas id="ch-atest-mensal"></canvas></div>
      <div class="chart-insight">${insightSerie(stMensal.mesesLabels, stMensal.diasMes, v=>fmtNum(v)+" dias")}</div>
    </div>

    <div class="grid-2">
      <div class="panel">
        <h3>Dias perdidos por categoria de motivo</h3>
        <div class="hint">Onde o afastamento realmente pesa, agrupado por tipo</div>
        <div class="chart-wrap" style="height:320px;"><canvas id="ch-atest-categoria"></canvas></div>
        <div class="chart-insight">${insightRanking(st.porCategoria, "categoria", "dias", v=>fmtNum(v)+" dias")}</div>
      </div>
      <div class="panel">
        <h3>Top 5 motivos por dias perdidos</h3>
        <div class="hint">Motivo/CID específico, não a categoria</div>
        <div class="chart-wrap" style="height:320px;"><canvas id="ch-atest-motivo"></canvas></div>
        <div class="chart-insight">${insightRanking(st.topMotivos, "motivo", "dias", v=>fmtNum(v)+" dias")}</div>
      </div>
    </div>

    <div class="grid-2">
      <div class="panel">
        <h3>10 colaboradores com mais dias perdidos</h3>
        <table>
          <thead><tr><th>#</th><th>Colaborador</th><th class="num">Atestados</th><th class="num">Dias</th></tr></thead>
          <tbody>${st.topColaboradores.map((t,i)=>`<tr><td class="rank">${i+1}</td><td>${t.nome}</td><td class="num">${fmtNum(t.qtd)}</td><td class="num"><b>${fmtNum(t.dias)}</b></td></tr>`).join("")}</tbody>
        </table>
      </div>
      <div class="panel">
        <h3>10 maiores motivos</h3>
        <table>
          <thead><tr><th>#</th><th>Motivo / CID</th><th class="num">Atestados</th><th class="num">Dias</th><th class="num">% Dias</th></tr></thead>
          <tbody>${st.topMotivos.map((t,i)=>`<tr><td class="rank">${i+1}</td><td>${t.motivo}</td><td class="num">${fmtNum(t.qtd)}</td><td class="num"><b>${fmtNum(t.dias)}</b></td><td class="num">${st.totalDias ? (t.dias/st.totalDias*100).toFixed(1) : 0}%</td></tr>`).join("")}</tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <h3>Dias por categoria</h3>
      <div class="hint">Todas as categorias do período filtrado</div>
      <table>
        <thead><tr><th>Categoria</th><th class="num">Atestados</th><th class="num">Dias</th><th class="num">% Dias</th></tr></thead>
        <tbody>${st.porCategoria.map(c=>`<tr><td>${c.categoria}</td><td class="num">${fmtNum(c.qtd)}</td><td class="num"><b>${fmtNum(c.dias)}</b></td><td class="num">${st.totalDias ? (c.dias/st.totalDias*100).toFixed(1) : 0}%</td></tr>`).join("")}</tbody>
      </table>
    </div>
  `;
};

initCharts.atestados = () => {
  const at = DATA.atestados;
  if(!at.lancamentos || !at.lancamentos.length) return;
  const st = computarAtestadosStats(filtrarAtestados(at.lancamentos, FILTRO_ATESTADOS));
  const stMensal = computarAtestadosStats(filtrarAtestados(at.lancamentos, FILTRO_ATESTADOS, true));

  // Dias (barra) e quantidade de atestados (linha) juntos: um atestado longo pesa muito em dias sem
  // mexer na contagem, e é justamente esse descolamento que interessa enxergar.
  mkChart("ch-atest-mensal", {
    type:"bar",
    data:{ labels:stMensal.mesesLabels, datasets:[
      { label:"Dias perdidos", data:stMensal.diasMes, backgroundColor:COLORS.red, borderRadius:4, yAxisID:"y" },
      { type:"line", label:"Atestados", data:stMensal.atestadosMes, borderColor:COLORS.ink, borderWidth:2.5,
        pointRadius:3, pointBackgroundColor:COLORS.ink, tension:.25, yAxisID:"y1",
        datalabels:{ display:true, align:"top", offset:6, color:COLORS.ink, font:{size:10, weight:700}, formatter:fmtLabelNum } }
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{position:"bottom", labels:{boxWidth:10, usePointStyle:true, pointStyle:"circle"}},
        datalabels:{ display:(ctx)=>ctx.datasetIndex===1 } },
      layout:{ padding:{ top:20 } },
      scales:{
        y:{ position:"left", grid:{color:COLORS.grid}, title:{display:true, text:"Dias"} },
        y1:{ position:"right", grid:{display:false}, title:{display:true, text:"Atestados"} },
        x:{ grid:{display:false} } } }
  });

  const cats = st.porCategoria.slice(0,10);
  mkChart("ch-atest-categoria", {
    type:"bar",
    data:{ labels:cats.map(c=>c.categoria), datasets:[{ data:cats.map(c=>c.dias), backgroundColor:COLORS.ink, borderRadius:4 }]},
    options:{ indexAxis:"y", responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false},
        datalabels:{ display:true, anchor:"end", align:"right", color:COLORS.ink, font:{size:10, weight:700}, formatter:fmtLabelNum } },
      layout:{ padding:{ right:40 } },
      scales:{ x:{grid:{color:COLORS.grid}}, y:{grid:{display:false}} } }
  });

  const motivos = st.topMotivos.slice(0,5);
  const totalMotivos = sumArr(motivos.map(m=>m.dias));
  mkChart("ch-atest-motivo", {
    type:"doughnut",
    data:{ labels:motivos.map(m=>m.motivo), datasets:[{ data:motivos.map(m=>m.dias),
      backgroundColor:[COLORS.red, COLORS.ink, COLORS.amber, "#B9BCC6", "#E58A93"], borderWidth:2, borderColor:"#fff" }]},
    options:{ responsive:true, maintainAspectRatio:false, cutout:"58%",
      plugins:{ legend:{position:"bottom", labels:{boxWidth:10, font:{size:10}, usePointStyle:true, pointStyle:"circle"}},
        datalabels:{ display:(ctx)=>totalMotivos>0 && ctx.dataset.data[ctx.dataIndex]/totalMotivos > 0.03, color:"#fff", font:{size:10, weight:700},
          formatter:(v)=> totalMotivos ? Math.round(v/totalMotivos*100)+"%" : "" } } }
  });
};

/* -------------------- INFRAÇÕES -------------------- */
function infracoesPagina(){
  const filtro = FILTRO_ANO.infracoes;
  const inf = infracoesView = (filtro === "todos" || DATA.infracoes.lancamentos.length === 0)
    ? DATA.infracoes
    : computarInfracoesStats(DATA.infracoes.lancamentos.filter(r=>r.d.startsWith(filtro)));
  const totalTurnos = inf.porTurno.turno1 + inf.porTurno.turno2;
  return `
    <div class="page-head"><h2>Infrações</h2><p>Ocorrências, tipos, turnos e motoristas${inf.labels.length ? ` — ${inf.labels[0]} a ${inf.labels[inf.labels.length-1]}` : ""}</p>${montarFiltroAno("infracoes", DATA.infracoes.lancamentos)}</div>
    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Total do período</div><div class="val">${fmtNum(inf.totalPeriodo)}</div></div>
      <div class="kpi"><div class="lbl">Uso de celular</div><div class="val">${fmtNum(inf.usoCelular)}</div><div class="delta up">ocorrências no período</div></div>
      <div class="kpi"><div class="lbl">1º Turno</div><div class="val">${inf.porTurno.turno1}</div><div class="delta flat">${totalTurnos ? ((inf.porTurno.turno1/totalTurnos)*100).toFixed(0) : 0}% do total</div></div>
      <div class="kpi"><div class="lbl">2º Turno</div><div class="val">${inf.porTurno.turno2}</div></div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <h3>Ocorrências mensais</h3>
        <div class="chart-wrap" style="height:260px;"><canvas id="ch-inf-mensal"></canvas></div>
        <div class="chart-insight">${insightSerie(inf.labels, inf.ocorrencias, fmtNum)}</div>
      </div>
      <div class="panel">
        <h3>Por tipo de infração</h3>
        <div class="chart-wrap" style="height:260px;"><canvas id="ch-inf-tipo"></canvas></div>
        <div class="chart-insight">${insightComposicao(inf.porTipo, "tipo", "valor")}</div>
      </div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <h3>10 motoristas com mais infrações</h3>
        <table>
          <thead><tr><th>#</th><th>Motorista</th><th class="num">Total</th></tr></thead>
          <tbody>${inf.topMotoristas.map((t,i)=>`<tr><td class="rank">${i+1}</td><td>${t.nome}</td><td class="num"><b>${t.total}</b></td></tr>`).join("")}</tbody>
        </table>
      </div>
      <div class="panel">
        <h3>10 placas com mais infrações</h3>
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
      <div class="chart-insight">${insightSerie(inf.diario.labels.slice(-14), inf.diario.labels.slice(-14).map((_,i)=>{ const t1=inf.diario.turno1.slice(-14)[i], t2=inf.diario.turno2.slice(-14)[i]; return (t1||0)+(t2||0); }), fmtNum)}</div>
    </div>
  `;
};
function infracoesChartsBase(){
  const inf = infracoesView || DATA.infracoes;
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

/* -------------------- ENTREGAS -------------------- */
// Aba "Receita e viagens" (planilha importada) — a tela Entregas em si é montada mais abaixo, junto com a Programação diária
function entregasReceita(){
  const filtro = FILTRO_ANO.entregas;
  const e = entregasView = (filtro === "todos" || DATA.entregas.lancamentos.length === 0)
    ? DATA.entregas
    : computarEntregasStats(DATA.entregas.lancamentos.filter(r=>r.d.startsWith(filtro)));
  const vazio = DATA.entregas.lancamentos.length === 0;
  return `
    <div class="page-head">
      <h2>Entregas</h2>
      <p>Coletas e entregas — receita, viagens e ranking por motorista, cliente e transportadora${e.mensalLabels.length ? ` — ${e.mensalLabels[0]} a ${e.mensalLabels[e.mensalLabels.length-1]}` : ""}</p>
      ${montarFiltroAno("entregas", DATA.entregas.lancamentos)}
    </div>
    ${vazio ? `
    <div class="panel">
      <div class="empty-state" style="padding:24px;"><div class="glyph">🚚</div><p>Nenhuma entrega importada ainda. Vá em <b>Entrada de Dados → Entregas</b> pra importar a planilha ou lançar uma operação avulsa.</p></div>
    </div>` : `
    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Total de Receitas</div><div class="val">${fmtBRL(e.totalReceitas)}</div></div>
      <div class="kpi"><div class="lbl">Soma de Viagens</div><div class="val">${fmtNum(e.totalViagens)}</div></div>
      <div class="kpi"><div class="lbl">Ticket Médio</div><div class="val">${fmtBRL2(e.ticketMedio)}</div></div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <h3>Demonstrativo em Valor R$ (mensal)</h3>
        <div class="chart-wrap" style="height:260px;"><canvas id="ch-ent-mensal"></canvas></div>
        <div class="chart-insight">${insightSerie(e.mensalLabels, e.mensalValor, fmtBRL)}</div>
      </div>
      <div class="panel">
        <h3>Tipo de Serviço</h3>
        <div class="hint">% sobre o valor total</div>
        <div class="chart-wrap" style="height:260px;"><canvas id="ch-ent-tipo"></canvas></div>
        <div class="chart-insight">${insightComposicao(e.porTipo, "tipo", "valor")}</div>
      </div>
    </div>
    ${entQuinzenaPainel()}
    <div class="grid-2">
      <div class="panel">
        <h3>Viagens por Motorista</h3>
        <table>
          <thead><tr><th>#</th><th>Motorista</th><th class="num">Viagens</th></tr></thead>
          <tbody>${e.porMotorista.map((t,i)=>`<tr><td class="rank">${i+1}</td><td>${t.nome}</td><td class="num"><b>${fmtNum(t.viagens)}</b></td></tr>`).join("")}</tbody>
        </table>
      </div>
      <div class="panel">
        <h3>Valor por Transportadora</h3>
        <table>
          <thead><tr><th>#</th><th>Transportadora</th><th class="num">Valor</th></tr></thead>
          <tbody>${e.porTransportadora.map((t,i)=>`<tr><td class="rank">${i+1}</td><td>${t.transportadora}</td><td class="num"><b>${fmtBRL2(t.valor)}</b></td></tr>`).join("")}</tbody>
        </table>
      </div>
    </div>
    <div class="panel">
      <h3>Top 10 clientes</h3>
      <table>
        <thead><tr><th>#</th><th>Cliente</th><th class="num">Faturamento</th><th class="num">Operações</th><th class="num">% Part.</th></tr></thead>
        <tbody>${e.porCliente.map((t,i)=>`<tr><td class="rank">${i+1}</td><td>${t.cliente}</td><td class="num">${fmtBRL2(t.valor)}</td><td class="num">${fmtNum(t.qtd)}</td><td class="num">${t.pct.toFixed(2)}%</td></tr>`).join("")}</tbody>
      </table>
    </div>
    `}
  `;
};
function entregasReceitaCharts(){
  const e = entregasView || DATA.entregas;
  if(!e.mensalLabels || e.mensalLabels.length === 0) return; // nada pra desenhar antes da 1ª importação/lançamento
  mkChart("ch-ent-mensal", {
    type:"bar",
    data:{ labels:e.mensalLabels, datasets:[{ data:e.mensalValor, backgroundColor:COLORS.amber, borderRadius:5 }]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
        datalabels:{ display:true, anchor:"end", align:"top", offset:2, color:COLORS.ink, font:{size:10, weight:700}, formatter:fmtLabelBRL } },
      layout:{ padding:{ top:18 } },
      scales:{ y:{grid:{color:COLORS.grid}, ticks:{callback:v=>fmtMil(v)}}, x:{grid:{display:false}} } }
  });
  const totalTipo = sumArr(e.porTipo.map(t=>t.valor));
  mkChart("ch-ent-tipo", {
    type:"doughnut",
    data:{ labels:e.porTipo.map(t=>t.tipo), datasets:[{ data:e.porTipo.map(t=>t.valor),
      backgroundColor:[COLORS.amber, COLORS.red, "#B9BCC6", COLORS.green], borderWidth:2, borderColor:"#fff" }]},
    options:{ responsive:true, maintainAspectRatio:false, cutout:"60%",
      plugins:{legend:{position:"bottom", labels:{boxWidth:10, font:{size:10}, usePointStyle:true, pointStyle:"circle"}},
        datalabels:{ display:(ctx)=>ctx.dataset.data[ctx.dataIndex]/totalTipo > 0.02, color:"#fff", font:{size:10, weight:700},
          formatter:(v)=> totalTipo? (v/totalTipo*100).toFixed(2)+"%" : "" } } }
  });
  entQuinzenaGrafico();
};

/* ---------- Entregas: viagens por quinzena, com filtros ----------
   Cada linha da planilha é uma viagem (coluna QNT; vazia conta como 1). Os filtros valem só para este
   painel: quinzena (todas / só 1ª / só 2ª), tipo de serviço e período (mês inicial e final). */
const FILTRO_ENT_Q = { quinzena:"todas", servico:"todos", de:"", ate:"" };
const ENT_Q_CORES = { "ENTREGA":"#8C0011", "COLETA":"#D0021B", "RETIRADA":"#E1971F", "DESCARGA":"#5B5F6B" };
window.setFiltroEntQ = (campo, v) => { FILTRO_ENT_Q[campo] = v; navigate("entregas"); };
function entQuinzenaDados(){
  const e = entregasView || DATA.entregas;
  const lanc = (e.lancamentos || DATA.entregas.lancamentos || []);
  const servNome = (s) => (s||"").trim().toUpperCase() || "SEM TIPO";
  const servicos = [...new Set(lanc.map(r=>servNome(r.servico)))].sort((a,b)=>(ENT_Q_CORES[a]?0:1)-(ENT_Q_CORES[b]?0:1) || a.localeCompare(b));
  const meses = [...new Set(lanc.map(r=>r.d.slice(0,7)))].sort();
  const f = FILTRO_ENT_Q;
  const filtrados = lanc.filter(r=>{
    const q = Number(r.d.slice(8,10)) <= 15 ? "Q1" : "Q2", ym = r.d.slice(0,7);
    return (f.quinzena==="todas" || f.quinzena===q) && (f.servico==="todos" || servNome(r.servico)===f.servico)
      && (!f.de || ym >= f.de) && (!f.ate || ym <= f.ate);
  });
  const chaves = [...new Set(filtrados.map(r=>`${r.d.slice(0,7)}-${Number(r.d.slice(8,10))<=15?"Q1":"Q2"}`))].sort();
  const serie = (s) => chaves.map(k=>sumArr(filtrados.filter(r=>`${r.d.slice(0,7)}-${Number(r.d.slice(8,10))<=15?"Q1":"Q2"}`===k && (!s || servNome(r.servico)===s)).map(r=>r.qnt||1)));
  const totais = serie(null);
  const labels = chaves.map(k=>{ const [y,mm,q] = k.split("-"); return `${q} ${MONTH_ABBR[parseInt(mm,10)-1]}${meses.some(m=>m.slice(0,4)!==y) ? "/"+y.slice(2) : ""}`; });
  const servDoFiltro = servicos.filter(s=>filtrados.some(r=>servNome(r.servico)===s));
  return { lanc, servicos, meses, filtrados, chaves, labels, totais, serie, servDoFiltro };
}
function entQuinzenaPainel(){
  const D = entQuinzenaDados(), f = FILTRO_ENT_Q;
  const opt = (v,l,a) => `<option value="${v}" ${v===a?"selected":""}>${l}</option>`;
  const nomeMes = (m) => `${MONTH_ABBR[parseInt(m.slice(5,7),10)-1]}/${m.slice(2,4)}`;
  const total = sumArr(D.totais), n = D.totais.length;
  const media = n ? total/n : 0;
  const maxI = n ? D.totais.indexOf(Math.max(...D.totais)) : -1, minI = n ? D.totais.indexOf(Math.min(...D.totais)) : -1;
  const doQ = (q) => { const ks = D.chaves.map((k,i)=>k.endsWith(q) ? D.totais[i] : null).filter(v=>v!=null); return ks.length ? sumArr(ks)/ks.length : 0; };
  return `
    <div class="panel" style="margin-bottom:16px;">
      <h3>Viagens por quinzena</h3>
      <div class="hint">Cada lançamento da planilha é uma viagem (coluna QNT). Os filtros abaixo valem só para este painel.</div>
      <div class="filtro-bar" style="margin-bottom:12px;">
        <label>Quinzena<select onchange="setFiltroEntQ('quinzena',this.value)">${opt("todas","Todas",f.quinzena)}${opt("Q1","Só a 1ª quinzena (dia 1 a 15)",f.quinzena)}${opt("Q2","Só a 2ª quinzena (dia 16 ao fim)",f.quinzena)}</select></label>
        <label>Serviço<select onchange="setFiltroEntQ('servico',this.value)">${opt("todos","Todos",f.servico)}${D.servicos.map(s=>opt(s, s[0]+s.slice(1).toLowerCase(), f.servico)).join("")}</select></label>
        <label>De<select onchange="setFiltroEntQ('de',this.value)">${opt("","Início",f.de)}${D.meses.map(m=>opt(m, nomeMes(m), f.de)).join("")}</select></label>
        <label>Até<select onchange="setFiltroEntQ('ate',this.value)">${opt("","Último mês",f.ate)}${D.meses.map(m=>opt(m, nomeMes(m), f.ate)).join("")}</select></label>
      </div>
      <div class="os-resumo prog-resumo" style="margin:0 0 12px;">
        <div>Viagens no filtro<b>${fmtNum(total)}</b><small>${n} quinzena(s)</small></div>
        <div>Média por quinzena<b>${fmtNum(Math.round(media))}</b></div>
        <div>Maior quinzena<b>${maxI>=0 ? fmtNum(D.totais[maxI]) : "—"}</b><small>${maxI>=0 ? D.labels[maxI] : ""}</small></div>
        <div>Menor quinzena<b>${minI>=0 ? fmtNum(D.totais[minI]) : "—"}</b><small>${minI>=0 ? D.labels[minI] : ""}</small></div>
        ${f.quinzena==="todas" ? `<div>Média 1ª x 2ª quinzena<b>${fmtNum(Math.round(doQ("Q1")))} x ${fmtNum(Math.round(doQ("Q2")))}</b><small>viagens por quinzena</small></div>` : ""}
      </div>
      <div class="chart-wrap" style="height:290px;"><canvas id="ch-ent-quinzena"></canvas></div>
      <div class="chart-insight">${insightSerie(D.labels, D.totais, fmtNum)}</div>
    </div>`;
}
function entQuinzenaGrafico(){
  if(!document.getElementById("ch-ent-quinzena")) return;
  const D = entQuinzenaDados();
  const empilhar = FILTRO_ENT_Q.servico === "todos" && D.servDoFiltro.length > 1;
  const datasets = empilhar
    ? D.servDoFiltro.map(s=>({ label:s[0]+s.slice(1).toLowerCase(), data:D.serie(s), backgroundColor:ENT_Q_CORES[s]||"#B9BBC6", stack:"q", borderColor:"#fff", borderWidth:{ top:1 }, borderRadius:3, maxBarThickness:44 }))
    : [{ label:"Viagens", data:D.totais, backgroundColor:COLORS.redDark, borderRadius:4, maxBarThickness:44 }];
  const totalNoTopo = { id:"entQTot", afterDatasetsDraw(chart){
    const { ctx } = chart; ctx.save(); ctx.font = "700 10.5px Inter, system-ui, sans-serif"; ctx.fillStyle = COLORS.ink; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    D.totais.forEach((v,i)=>{ let topo = Infinity, x = null; chart.data.datasets.forEach((_,di)=>{ const b = chart.getDatasetMeta(di).data[i]; if(b && chart.data.datasets[di].data[i]){ topo = Math.min(topo, b.y); x = b.x; } });
      if(x!=null) ctx.fillText(fmtNum(v), x, topo - 4); });
    ctx.restore(); } };
  mkChart("ch-ent-quinzena", {
    type:"bar", data:{ labels:D.labels, datasets },
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ display:empilhar, position:"bottom", labels:{ boxWidth:10, usePointStyle:true, pointStyle:"rectRounded" } },
        tooltip:{ mode:"index", filter:(it)=>it.raw>0, callbacks:{ footer:(its)=>`Total: ${fmtNum(D.totais[its[0].dataIndex])} viagens` } },
        datalabels:{ display:false } },
      layout:{ padding:{ top:18 } },
      scales:{ y:{ stacked:empilhar, beginAtZero:true, grid:{ color:COLORS.grid }, ticks:{ precision:0 } },
               x:{ stacked:empilhar, grid:{ display:false }, ticks:{ maxRotation:60, minRotation:D.labels.length>14 ? 60 : 0 } } } },
    plugins:[totalNoTopo]
  });
}
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
      <div class="chart-insight">${insightSerie(ac.labels, ac.valores, fmtNum)}</div>
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
  const anosDisponiveis = [...new Set(cp.lancamentos.map(i=>i.dataVencimento).filter(Boolean).map(d=>d.slice(0,4)))].sort();
  const fornecedoresDisponiveis = [...new Set(cp.lancamentos.map(i=>i.prestador).filter(Boolean))].sort();
  const tiposDisponiveis = [...new Set(cp.lancamentos.map(i=>i.tipoServico).filter(Boolean))].sort();
  const statusDisponiveis = [...new Set(cp.lancamentos.map(i=>i.status).filter(Boolean))].sort();
  const opt = (valor,label,atual) => `<option value="${valor}" ${atual===valor?"selected":""}>${label}</option>`;

  // KPIs, ranking e agenda respeitam TODOS os filtros (Ano/Mês/Status/Fornecedor/Tipo).
  const itensFiltrados = filtrarContas(cp.lancamentos, FILTRO_CONTAS);
  const pagos = itensFiltrados.filter(i=>i.status==="Pago");
  const aPagarList = itensFiltrados.filter(i=>i.status!=="Pago");
  const vencidasList = aPagarList.filter(i=>statusConta(i)==="Vencido");
  const venceSemanaList = aPagarList.filter(i=>statusConta(i)==="Vence na Semana");
  const proxVencList = aPagarList.filter(i=>statusConta(i)==="A Vencer");
  const statsFiltrado = computarContasPagarStats(itensFiltrados);

  // "Análise Mensal" ignora o filtro de Mês de propósito — ele já quebra por mês, então aplicar o
  // filtro deixaria o gráfico com uma barra só.
  const statsMensal = computarContasPagarStats(filtrarContas(cp.lancamentos, FILTRO_CONTAS, true));

  const agendaBuckets = { "Vencido":vencidasList, "Vence na Semana":venceSemanaList, "A Vencer":proxVencList, "Pago":pagos, "Todas":itensFiltrados };
  const agendaItens = [...(agendaBuckets[FILTRO_AGENDA]||itensFiltrados)].sort((a,b)=>b.valor-a.valor);
  const agendaBtn = (valor,label,cor) => `<button class="sub-tab-btn ${FILTRO_AGENDA===valor?"active":""}" onclick="setFiltroAgenda('${valor}')"><span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${cor}; margin-right:5px;"></span>${label}</button>`;

  return `
    <div class="page-head"><h2>Contas a Pagar</h2><p>Fornecedores/prestadores de serviço — controle de vencimentos, situação e forma de pagamento${cp.lancamentos.length ? ` · ${fmtNum(cp.lancamentos.length)} lançamento(s)` : ""}</p></div>

    <div class="panel" style="margin-bottom:16px;">
      <h3 style="margin-bottom:10px;">Filtros</h3>
      <div class="filtro-bar">
        <label>Ano<select onchange="setFiltroContas('ano',this.value)">
          ${opt("todos","Todos",FILTRO_CONTAS.ano)}${anosDisponiveis.map(a=>opt(a,a,FILTRO_CONTAS.ano)).join("")}
        </select></label>
        <label>Mês<select onchange="setFiltroContas('mes',this.value)">
          ${opt("todos","Todos",FILTRO_CONTAS.mes)}${MONTH_ABBR.map((m,i)=>opt(String(i+1), m[0].toUpperCase()+m.slice(1), FILTRO_CONTAS.mes)).join("")}
        </select></label>
        <label>Status<select onchange="setFiltroContas('status',this.value)">
          ${opt("todos","Todos",FILTRO_CONTAS.status)}${statusDisponiveis.map(s=>opt(s,s,FILTRO_CONTAS.status)).join("")}
        </select></label>
        <label>Fornecedor<select onchange="setFiltroContas('fornecedor',this.value)">
          ${opt("todos","Todos",FILTRO_CONTAS.fornecedor)}${fornecedoresDisponiveis.map(f=>opt(f,f,FILTRO_CONTAS.fornecedor)).join("")}
        </select></label>
        <label>Tipo de Serviço<select onchange="setFiltroContas('tipo',this.value)">
          ${opt("todos","Todos",FILTRO_CONTAS.tipo)}${tiposDisponiveis.map(t=>opt(t,t,FILTRO_CONTAS.tipo)).join("")}
        </select></label>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Total de Contas</div><div class="val">${fmtNum(itensFiltrados.length)}</div></div>
      <div class="kpi"><div class="lbl">Valor Total</div><div class="val">${fmtBRL(sumArr(itensFiltrados.map(i=>i.valor)))}</div></div>
      <div class="kpi"><div class="lbl">Total Pago</div><div class="val">${fmtBRL(sumArr(pagos.map(i=>i.valor)))}</div><div class="delta flat">${fmtNum(pagos.length)} conta(s)</div></div>
      <div class="kpi"><div class="lbl">Total a Pagar</div><div class="val">${fmtBRL(sumArr(aPagarList.map(i=>i.valor)))}</div><div class="delta flat">${fmtNum(aPagarList.length)} conta(s)</div></div>
      <div class="kpi"><div class="lbl">Contas Vencidas</div><div class="val">${fmtBRL(sumArr(vencidasList.map(i=>i.valor)))}</div>${vencidasList.length>0?`<span class="delta up">↑ ${fmtNum(vencidasList.length)} conta(s)</span>`:`<span class="delta down">↓ nenhuma</span>`}</div>
      <div class="kpi"><div class="lbl">Venc. na Semana</div><div class="val">${fmtBRL(sumArr(venceSemanaList.map(i=>i.valor)))}</div><div class="delta flat">${fmtNum(venceSemanaList.length)} conta(s)</div></div>
      <div class="kpi"><div class="lbl">Próx. Vencimentos</div><div class="val">${fmtBRL(sumArr(proxVencList.map(i=>i.valor)))}</div><div class="delta flat">${fmtNum(proxVencList.length)} conta(s)</div></div>
    </div>

    <div class="panel" style="margin-bottom:16px;">
      <h3>Agenda de Vencimentos — contas que exigem atenção</h3>
      <div class="tabs" style="margin:6px 0 12px;">
        ${agendaBtn("Vencido","Vencidas",COLORS.red)}
        ${agendaBtn("Vence na Semana","Vence na Semana",COLORS.amber)}
        ${agendaBtn("A Vencer","A Vencer",COLORS.inkSoft)}
        ${agendaBtn("Pago","Pagas",COLORS.green)}
        ${agendaBtn("Todas","Todas",COLORS.ink)}
      </div>
      ${agendaItens.length === 0 ? `
      <div class="empty-state" style="padding:24px;"><div class="glyph">📋</div><p>Nenhuma conta nessa situação com os filtros atuais.</p></div>` : `
      <table>
        <thead><tr><th>Fornecedor</th><th>Serviço/Descrição</th><th class="num">Valor</th><th>Vencimento</th><th>Status</th><th>Situação</th><th>Ação</th></tr></thead>
        <tbody>
          ${agendaItens.map(i=>{
            const st = statusConta(i);
            return `<tr>
              <td>${i.prestador}</td>
              <td>${i.servico || i.tipoServico}${(i.parcela && String(i.parcela).includes("/")) ? ` <span class="hint" style="margin:0;">(${i.parcela})</span>` : ""}</td>
              <td class="num">${fmtBRL2(i.valor)}</td>
              <td>${fmtDataBR(i.dataVencimento)}</td>
              <td>${i.status}</td>
              <td><span class="badge ${statusBadgeClass(st)}">${st}</span></td>
              <td>${i.status==="Pago" ? `<span class="hint" style="margin:0;">pago em ${fmtDataBR(i.dataPagamento)}</span>` : `<button onclick="marcarContaPaga('${i.id}')" style="background:var(--green); color:#fff; border:none; padding:5px 10px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer;">Marcar como pago</button>`}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`}
    </div>

    <div class="page-head" style="margin-bottom:8px;"><h3 style="font-size:16px;">Análise Mensal</h3><p>Ignora o filtro de Mês acima — mostra o ano inteiro pra dar contexto</p></div>
    <div class="grid-2">
      <div class="panel">
        <h3>Valores por Mês: Total, Pago e A Pagar</h3>
        <div class="chart-wrap" style="height:280px;"><canvas id="ch-cp-mensal"></canvas></div>
        <div class="chart-insight">${insightSerie(statsMensal.mesesLabels, statsMensal.totalMes, fmtBRL)}</div>
      </div>
      <div class="panel">
        <h3>Quantidade de Contas por Mês</h3>
        <div class="chart-wrap" style="height:280px;"><canvas id="ch-cp-qtdmes"></canvas></div>
        <div class="chart-insight">${insightSerie(statsMensal.mesesLabels, statsMensal.qtdMes, fmtNum)}</div>
      </div>
    </div>
    <div class="panel" style="margin-bottom:16px;">
      <h3>Previsto x Pago (mensal)</h3>
      <div class="hint">Total previsto x total já pago, mês a mês</div>
      <div class="chart-wrap" style="height:260px;"><canvas id="ch-cp-previstopago"></canvas></div>
      <div class="chart-insight">${(()=>{ const totG=sumArr(statsMensal.totalMes), pagoG=sumArr(statsMensal.pagoMes); return totG ? `${fmtBRL(pagoG)} pagos de ${fmtBRL(totG)} no período (${(pagoG/totG*100).toFixed(0)}%).` : "Sem dados no período."; })()}</div>
    </div>

    <div class="grid-2">
      <div class="panel">
        <h3>Custo por tipo de serviço</h3>
        <div class="hint">Considera os filtros acima (Ano/Mês/Status/Fornecedor/Tipo)</div>
        <div class="chart-wrap" style="height:260px;"><canvas id="ch-cp-tipo"></canvas></div>
        <div class="chart-insight">${insightRanking(statsFiltrado.porTipoArr, "tipo", "valor", fmtBRL2)}</div>
      </div>
      <div class="panel">
        <h3>Maiores fornecedores</h3>
        <table>
          <thead><tr><th>#</th><th>Fornecedor</th><th class="num">Valor</th></tr></thead>
          <tbody>${statsFiltrado.topFornecedores.map((t,i)=>`<tr><td class="rank">${i+1}</td><td>${t.fornecedor}</td><td class="num">${fmtBRL2(t.valor)}</td></tr>`).join("")}</tbody>
        </table>
      </div>
    </div>
  `;
};
initCharts.contaspagar = () => {
  const cp = DATA.contasPagar;
  const itensFiltrados = filtrarContas(cp.lancamentos, FILTRO_CONTAS);
  const statsFiltrado = computarContasPagarStats(itensFiltrados);
  const statsMensal = computarContasPagarStats(filtrarContas(cp.lancamentos, FILTRO_CONTAS, true));

  mkChart("ch-cp-mensal", {
    type:"bar",
    data:{ labels:statsMensal.mesesLabels, datasets:[
      { label:"Valor Total", data:statsMensal.totalMes, backgroundColor:COLORS.ink, borderRadius:3 },
      { label:"Valor Pago", data:statsMensal.pagoMes, backgroundColor:COLORS.green, borderRadius:3 },
      { label:"Valor A Pagar", data:statsMensal.aPagarMes, backgroundColor:COLORS.amber, borderRadius:3 }
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{legend:{position:"bottom", labels:{boxWidth:10, usePointStyle:true, pointStyle:"circle"}}},
      scales:{ y:{grid:{color:COLORS.grid}, ticks:{callback:v=>fmtMil(v)}}, x:{grid:{display:false}} } }
  });
  mkChart("ch-cp-qtdmes", {
    type:"bar",
    data:{ labels:statsMensal.mesesLabels, datasets:[{ data:statsMensal.qtdMes, backgroundColor:COLORS.red, borderRadius:4 }]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
        datalabels:{ display:(ctx)=>ctx.dataset.data[ctx.dataIndex]>0, anchor:"end", align:"top", offset:2, color:COLORS.ink, font:{size:10, weight:700}, formatter:fmtLabelNum } },
      layout:{ padding:{ top:16 } },
      scales:{ y:{grid:{color:COLORS.grid}}, x:{grid:{display:false}} } }
  });
  mkChart("ch-cp-previstopago", {
    type:"line",
    data:{ labels:statsMensal.mesesLabels, datasets:[
      { label:"Valor Total", data:statsMensal.totalMes, borderColor:COLORS.ink, backgroundColor:COLORS.ink+"14", fill:true, tension:.3, pointRadius:2 },
      { label:"Valor Pago", data:statsMensal.pagoMes, borderColor:COLORS.green, backgroundColor:COLORS.green+"14", fill:true, tension:.3, pointRadius:2 }
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{legend:{position:"bottom", labels:{boxWidth:10, usePointStyle:true, pointStyle:"circle"}}},
      scales:{ y:{grid:{color:COLORS.grid}, ticks:{callback:v=>fmtMil(v)}}, x:{grid:{display:false}} } }
  });
  mkChart("ch-cp-tipo", {
    type:"bar",
    data:{ labels:statsFiltrado.porTipoArr.map(t=>t.tipo), datasets:[{ data:statsFiltrado.porTipoArr.map(t=>t.valor), backgroundColor:COLORS.red, borderRadius:4 }]},
    options:{ indexAxis:"y", responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
        datalabels:{ display:true, anchor:"end", align:"right", color:COLORS.ink, font:{size:10, weight:700}, formatter:fmtLabelBRL } },
      layout:{ padding:{ right:46 } },
      scales:{ x:{grid:{color:COLORS.grid}, ticks:{callback:v=>fmtMil(v)}}, y:{grid:{display:false}} } }
  });
};

/* -------------------- FATURAMENTO -------------------- */
renderers.faturamento = () => {
  const ft = DATA.faturamento;
  const anosDisponiveis = [...new Set(ft.lancamentos.map(i=>i.vencimento).filter(Boolean).map(d=>d.slice(0,4)))].sort();
  const balsasDisponiveis = [...new Set(ft.lancamentos.map(i=>balsaGrupo(i.balsaViagem)))].sort();
  const opt = (valor,label,atual) => `<option value="${valor}" ${atual===valor?"selected":""}>${label}</option>`;

  const itensFiltrados = filtrarFaturamento(ft.lancamentos, FILTRO_FATURAMENTO);
  const statsFiltrado = computarFaturamentoStats(itensFiltrados);
  // "Análise Mensal" ignora o filtro de Mês de propósito — mesmo motivo do Contas a Pagar.
  const statsMensal = computarFaturamentoStats(filtrarFaturamento(ft.lancamentos, FILTRO_FATURAMENTO, true));

  const totalFaturado = sumArr(itensFiltrados.map(i=>i.valor));
  const ticketMedio = itensFiltrados.length ? totalFaturado / itensFiltrados.length : 0;
  const maxMes = Math.max(0, ...statsMensal.valorMes);
  const mesMaior = maxMes > 0 ? statsMensal.mesesLabels[statsMensal.valorMes.indexOf(maxMes)] : "—";

  return `
    <div class="page-head"><h2>Faturamento</h2><p>Contratos faturados — controle mensal por vencimento e resumo por balsa/viagem${ft.lancamentos.length ? ` · ${fmtNum(ft.lancamentos.length)} lançamento(s)` : ""}</p></div>

    <div class="panel" style="margin-bottom:16px;">
      <h3 style="margin-bottom:10px;">Filtros</h3>
      <div class="filtro-bar">
        <label>Ano<select onchange="setFiltroFaturamento('ano',this.value)">
          ${opt("todos","Todos",FILTRO_FATURAMENTO.ano)}${anosDisponiveis.map(a=>opt(a,a,FILTRO_FATURAMENTO.ano)).join("")}
        </select></label>
        <label>Mês<select onchange="setFiltroFaturamento('mes',this.value)">
          ${opt("todos","Todos",FILTRO_FATURAMENTO.mes)}${MONTH_ABBR.map((m,i)=>opt(String(i+1), m[0].toUpperCase()+m.slice(1), FILTRO_FATURAMENTO.mes)).join("")}
        </select></label>
        <label>Balsa/Viagem<select onchange="setFiltroFaturamento('balsa',this.value)">
          ${opt("todos","Todas",FILTRO_FATURAMENTO.balsa)}${balsasDisponiveis.map(b=>opt(b,b,FILTRO_FATURAMENTO.balsa)).join("")}
        </select></label>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Total Faturado</div><div class="val">${fmtBRL(totalFaturado)}</div></div>
      <div class="kpi"><div class="lbl">Qtde de Lançamentos</div><div class="val">${fmtNum(itensFiltrados.length)}</div></div>
      <div class="kpi"><div class="lbl">Ticket Médio</div><div class="val">${fmtBRL2(ticketMedio)}</div></div>
      <div class="kpi"><div class="lbl">Mês de Maior Faturamento</div><div class="val">${mesMaior}</div></div>
      <div class="kpi"><div class="lbl">Balsas/Rotas Distintas</div><div class="val">${fmtNum(statsFiltrado.porBalsaArr.length)}</div></div>
    </div>

    <div class="page-head" style="margin-bottom:8px;"><h3 style="font-size:16px;">Análise Mensal (por Vencimento)</h3><p>Ignora o filtro de Mês acima — mostra o ano inteiro pra dar contexto</p></div>
    <div class="grid-2">
      <div class="panel">
        <h3>Faturamento por Mês</h3>
        <div class="chart-wrap" style="height:280px;"><canvas id="ch-ft-mensal"></canvas></div>
        <div class="chart-insight">${insightSerie(statsMensal.mesesLabels, statsMensal.valorMes, fmtBRL)}</div>
      </div>
      <div class="panel">
        <h3>Quantidade de Lançamentos por Mês</h3>
        <div class="chart-wrap" style="height:280px;"><canvas id="ch-ft-qtdmes"></canvas></div>
        <div class="chart-insight">${insightSerie(statsMensal.mesesLabels, statsMensal.qtdMes, fmtNum)}</div>
      </div>
    </div>

    <div class="grid-2">
      <div class="panel">
        <h3>Resumo por Balsa/Viagem — Top 12</h3>
        <div class="hint">Considera os filtros acima (Ano/Mês/Balsa)</div>
        <div class="chart-wrap" style="height:320px;"><canvas id="ch-ft-balsa"></canvas></div>
        <div class="chart-insight">${insightRanking(statsFiltrado.porBalsaArr, "nome", "valor", fmtBRL2)}</div>
      </div>
      <div class="panel">
        <h3>Ranking completo por Balsa/Viagem</h3>
        <table>
          <thead><tr><th>#</th><th>Balsa/Viagem</th><th class="num">Qtde</th><th class="num">Valor</th></tr></thead>
          <tbody>${statsFiltrado.porBalsaArr.map((t,i)=>`<tr><td class="rank">${i+1}</td><td>${t.nome}</td><td class="num">${fmtNum(t.qtd)}</td><td class="num">${fmtBRL2(t.valor)}</td></tr>`).join("")}</tbody>
        </table>
      </div>
    </div>

    <div class="panel" style="margin-top:16px;">
      <h3>Lançamentos</h3>
      <div class="hint">Ordenado por vencimento, mais recente primeiro</div>
      ${itensFiltrados.length === 0 ? `
      <div class="empty-state" style="padding:24px;"><div class="glyph">🧾</div><p>Nenhum lançamento com os filtros atuais.</p></div>` : `
      <table>
        <thead><tr><th>Contrato</th><th>NF</th><th>Balsa/Viagem</th><th class="num">Valor</th><th>Deadline</th><th>Vencimento</th></tr></thead>
        <tbody>
          ${[...itensFiltrados].sort((a,b)=>(b.vencimento||"").localeCompare(a.vencimento||"")).map(i=>`<tr>
            <td>${i.contrato||"—"}</td>
            <td>${i.nf||"—"}</td>
            <td>${i.balsaViagem||"—"}</td>
            <td class="num">${fmtBRL2(i.valor)}</td>
            <td>${fmtDataBR(i.deadline)}</td>
            <td>${fmtDataBR(i.vencimento)}</td>
          </tr>`).join("")}
        </tbody>
      </table>`}
    </div>
  `;
};
initCharts.faturamento = () => {
  const ft = DATA.faturamento;
  const itensFiltrados = filtrarFaturamento(ft.lancamentos, FILTRO_FATURAMENTO);
  const statsFiltrado = computarFaturamentoStats(itensFiltrados);
  const statsMensal = computarFaturamentoStats(filtrarFaturamento(ft.lancamentos, FILTRO_FATURAMENTO, true));
  const topBalsa = statsFiltrado.porBalsaArr.slice(0,12);

  mkChart("ch-ft-mensal", {
    type:"bar",
    data:{ labels:statsMensal.mesesLabels, datasets:[{ label:"Faturamento", data:statsMensal.valorMes, backgroundColor:COLORS.red, borderRadius:4 }]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
        datalabels:{ display:(ctx)=>ctx.dataset.data[ctx.dataIndex]>0, anchor:"end", align:"top", color:COLORS.ink, font:{size:10, weight:700}, formatter:fmtLabelBRL } },
      layout:{ padding:{ top:16 } },
      scales:{ y:{grid:{color:COLORS.grid}, ticks:{callback:v=>fmtMil(v)}}, x:{grid:{display:false}} } }
  });
  mkChart("ch-ft-qtdmes", {
    type:"bar",
    data:{ labels:statsMensal.mesesLabels, datasets:[{ data:statsMensal.qtdMes, backgroundColor:COLORS.ink, borderRadius:4 }]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
        datalabels:{ display:(ctx)=>ctx.dataset.data[ctx.dataIndex]>0, anchor:"end", align:"top", offset:2, color:COLORS.ink, font:{size:10, weight:700}, formatter:fmtLabelNum } },
      layout:{ padding:{ top:16 } },
      scales:{ y:{grid:{color:COLORS.grid}}, x:{grid:{display:false}} } }
  });
  mkChart("ch-ft-balsa", {
    type:"bar",
    data:{ labels:topBalsa.map(t=>t.nome), datasets:[{ data:topBalsa.map(t=>t.valor), backgroundColor:COLORS.amber, borderRadius:4 }]},
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
  { key:"faturamento", ic:"🧾", label:"Faturamento", desc:"Importação de planilha de contratos ou lançamento avulso — contrato, NF, balsa/viagem, valor e vencimento" },
  { key:"belem", ic:"🏗️", label:"Operação Belém", desc:"Importação das planilhas de combustível, mão de obra e peças da operação de Belém" },
  { key:"entregas", ic:"🚚", label:"Entregas", desc:"Importação de planilha ou lançamento avulso por operação" },
  { key:"compras", ic:"🧰", label:"Compras de Peças", desc:"Lançamento diário — data, local/fornecedor, categoria e valor" },
  { key:"diesel", ic:"⛽", label:"Diesel", desc:"Custo mensal ou semanal" },
  { key:"manutencao", ic:"🔩", label:"Manutenção de Carreta", desc:"Custo mensal por tipo de serviço" },
  { key:"folha", ic:"💰", label:"Folha (Benefícios+Salário)", desc:"VT/VR, 40% adicional e salário — mensal" },
  { key:"horaextra", ic:"⏱️", label:"Hora Extra", desc:"Custo (R$) ou quantidade (horas) — mensal" },
  { key:"atestados", ic:"🩺", label:"Atestados", desc:"Ocorrências — mensal" },
  { key:"infracoes", ic:"🚨", label:"Infrações", desc:"Importação de planilha ou lançamento avulso por ocorrência" },
  { key:"acidentes", ic:"⚠️", label:"Acidentes & Incidentes", desc:"Ocorrências mensais ou registro de problema/ação" }
];
// Quem não é Diretor não vê as abas de Contas a Pagar/Faturamento na Entrada de Dados — mesma
// restrição do menu lateral, só que aplicada às abas dessa tela.
function entryModulesVisiveis(){
  return MEU_PAPEL === "diretor" ? ENTRY_MODULES : ENTRY_MODULES.filter(m=>!PAGINAS_SO_DIRETOR.includes(m.key));
}

const CATEGORIAS_COMPRAS = ["💡 ELÉTRICA","🧱 ESTRUTURA / CABINE","🚛 SUSPENSÃO / AR","🔧 PEÇAS MECÂNICAS","🛢️ FILTROS E LUBRIFICANTES","🧪 QUÍMICOS / CONSUMO","🧰 FIXAÇÃO / METAIS","🧼 LIMPEZA / EPI","⚙️ SERVIÇOS"];
const MANUTENCAO_SERVICOS = ["Manutenção Geral","Pintura do Teto","Outros Serviços"];
const TIPOS_SERVICO = ["Manutenção e Reparação","Frete / Transporte","Consultoria","Jurídico","Contábil","TI / Software","Limpeza","Segurança","Combustível","Locação de Equipamento","Outros"];
const FORMAS_PAGAMENTO = ["Boleto","PIX","Transferência (TED/DOC)","Cartão","Dinheiro"];
const TIPOS_OCORRENCIA = ["Direção distraída","Não Uso do Cinto de Segurança","Excesso de Velocidade","Curva Brusca","Frenagem Brusca","Outros"];
const TIPOS_SERVICO_ENTREGA = ["ENTREGA","COLETA","DESCARGA"];

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
    ${entryModulesVisiveis().map((m,i)=>`<button class="tab-btn ${i===0?"active":""}" data-mod="${m.key}">${m.ic} ${m.label}</button>`).join("")}
  </div>

  <div class="grid-2">
    <div class="panel">
      <h3 id="entryFormTitle">${entryModulesVisiveis()[0].ic} ${entryModulesVisiveis()[0].label}</h3>
      <div class="hint" id="entryFormDesc">${entryModulesVisiveis()[0].desc}</div>
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
  entregas: () => `
    <div style="background:var(--red-soft); border:1px solid #F0B9C0; border-radius:12px; padding:16px; margin-top:12px;">
      <h4 style="font-size:13px; margin-bottom:4px;">📤 Importar planilha (.xlsx)</h4>
      <div class="hint" style="margin-bottom:10px;">
        Lê só a aba <b>"MATRIZ"</b> da planilha (as outras abas são ignoradas). Colunas esperadas nela:
        DATA, SERVIÇO, TRANSPORTADORA, CLIENTE, MOTORISTA, CARRO, QNT, VALOR, OBSERVAÇÃO (ANO e MÊS são
        ignoradas — calculadas a partir da própria data).<br>
        <b>Importar substitui todo o histórico de Entregas do sistema pelo conteúdo da aba MATRIZ.</b>
      </div>
      <input type="file" id="eg-import-file" accept=".xlsx,.xls,.csv" style="font-size:12.5px;">
      <button class="entry-submit" style="margin-top:10px;" onclick="importEntregasXlsx()">Importar e substituir</button>
      <div id="eg-import-status" class="hint" style="margin-top:10px;"></div>
    </div>
    <hr style="margin:20px 0; border:none; border-top:1px solid var(--line);">
    <div class="hint" style="margin-bottom:4px;">Ou lance uma operação avulsa manualmente:</div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px;">
      <label>Data<input type="date" id="eg-data" value="${new Date().toISOString().slice(0,10)}"></label>
      <label>Serviço<select id="eg-servico">${TIPOS_SERVICO_ENTREGA.map(t=>`<option>${t}</option>`).join("")}</select></label>
      <label>Transportadora<input type="text" id="eg-transportadora" list="dl-eg-transp" placeholder="Ex: SUZANO"></label>
      <datalist id="dl-eg-transp">${[...new Set(DATA.entregas.lancamentos.map(r=>r.transportadora))].sort().map(l=>`<option value="${l}">`).join("")}</datalist>
      <label>Cliente<input type="text" id="eg-cliente" list="dl-eg-clientes" placeholder="Ex: AMAZON INDUSTRIA"></label>
      <datalist id="dl-eg-clientes">${[...new Set(DATA.entregas.lancamentos.map(r=>r.cliente))].sort().map(l=>`<option value="${l}">`).join("")}</datalist>
      <label>Motorista<input type="text" id="eg-motorista" list="dl-eg-motoristas" placeholder="Ex: TOME"></label>
      <datalist id="dl-eg-motoristas">${[...new Set(DATA.entregas.lancamentos.map(r=>r.motorista))].sort().map(l=>`<option value="${l}">`).join("")}</datalist>
      <label>Carro / Placa<input type="text" id="eg-carro" placeholder="Ex: GCV3B63"></label>
      <label>Qtde<input type="number" id="eg-qnt" step="1" value="1" placeholder="1"></label>
      <label>Valor (R$)<input type="number" id="eg-valor" step="0.01" placeholder="0,00"></label>
      <label style="grid-column:1/-1;">Observação (opcional)<input type="text" id="eg-obs" placeholder="Ex: RETIRADA DE CARRETA"></label>
    </div>
    <button class="entry-submit" onclick="submitEntrega()">Adicionar operação</button>
  `,
  contaspagar: () => `
    <div style="background:var(--red-soft); border:1px solid #F0B9C0; border-radius:12px; padding:16px; margin-top:12px;">
      <h4 style="font-size:13px; margin-bottom:4px;">📤 Importar planilha (.xlsx)</h4>
      <div class="hint" style="margin-bottom:10px;">
        Lê só a aba <b>"MATRIZ"</b> da planilha (as outras abas são ignoradas). Colunas esperadas nela:
        FORNECEDOR, CNPJ, TIPO DO SERVIÇO, SERVIÇO, No. DA O.S, DATA DA O.S, PARCELA, VALOR (DO)
        SERVIÇO, FORMA DE PAGAMENTO, DATA DO VENCIMENTO, STATUS DO PAGAMENTO (MÊS, ANO, SEMANA e a
        coluna de situação são ignoradas — a situação de cada conta é sempre recalculada em cima da
        data de hoje, não da foto do dia em que a planilha foi exportada).<br>
        <b>Importar substitui todo o histórico de Contas a Pagar do sistema pelo conteúdo da aba MATRIZ.</b>
      </div>
      <input type="file" id="ecp-import-file" accept=".xlsx,.xls,.csv" style="font-size:12.5px;">
      <button class="entry-submit" style="margin-top:10px;" onclick="importContasPagarXlsx()">Importar e substituir</button>
      <div id="ecp-import-status" class="hint" style="margin-top:10px;"></div>
    </div>
    <hr style="margin:20px 0; border:none; border-top:1px solid var(--line);">
    <div class="hint" style="margin-bottom:4px;">Ou lance uma conta avulsa manualmente:</div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px;">
      <label style="grid-column:1/-1;">Fornecedor / Prestador de Serviço<input type="text" id="ecp-prestador" list="dl-prestadores" placeholder="Ex: MANUTENÇÃO E REPARAÇÃO CB MECA"></label>
      <datalist id="dl-prestadores">${[...new Set(DATA.contasPagar.lancamentos.map(r=>r.prestador))].sort().map(l=>`<option value="${l}">`).join("")}</datalist>
      <label>CNPJ<input type="text" id="ecp-cnpj" placeholder="00.000.000/0000-00"></label>
      <label>Tipo de Serviço<input type="text" id="ecp-tipo" list="dl-tipos-servico" placeholder="Ex: Manutenção e Reparação"></label>
      <datalist id="dl-tipos-servico">${TIPOS_SERVICO.map(t=>`<option value="${t}">`).join("")}</datalist>
      <label style="grid-column:1/-1;">Serviço / Descrição (opcional, se diferente do tipo)<input type="text" id="ecp-servico" placeholder="Ex: COMPRAS DE PEÇAS"></label>
      <label>Valor do Serviço (R$)<input type="number" id="ecp-valor" step="0.01" placeholder="0,00"></label>
      <label>Parcela (opcional)<input type="text" id="ecp-parcela" placeholder="Ex: 1/3"></label>
      <label>Forma de Pagamento<select id="ecp-forma">${FORMAS_PAGAMENTO.map(f=>`<option>${f}</option>`).join("")}</select></label>
      <label>Data de Emissão / da O.S.<input type="date" id="ecp-emissao" value="${new Date().toISOString().slice(0,10)}"></label>
      <label>Data de Vencimento<input type="date" id="ecp-vencimento"></label>
      <label style="grid-column:1/-1;">Nº do Documento / da O.S. (opcional)<input type="text" id="ecp-numdoc" placeholder="Ex: 0262"></label>
    </div>
    <button class="entry-submit" onclick="submitContaPagar()">Adicionar conta a pagar</button>
  `,
  faturamento: () => `
    <div style="background:var(--red-soft); border:1px solid #F0B9C0; border-radius:12px; padding:16px; margin-top:12px;">
      <h4 style="font-size:13px; margin-bottom:4px;">📤 Importar planilha (.xlsx)</h4>
      <div class="hint" style="margin-bottom:10px;">
        Procura a linha de cabeçalho (colunas <b>CONTRATO</b> e <b>VENCIMENTO</b>) em qualquer aba da
        planilha — não depende do nome da aba, já que ele muda a cada ano (ex: "CONTRATOS 2026").
        Colunas esperadas: CONTRATO, NF, DEADLINE, DOC, BALSA/VIAGEM, VALOR, VENCIMENTO. O mês de cada
        lançamento nos gráficos é sempre calculado a partir da coluna VENCIMENTO.<br>
        <b>Importar substitui todo o histórico de Faturamento do sistema pelo conteúdo da planilha.</b>
      </div>
      <input type="file" id="eft-import-file" accept=".xlsx,.xls,.csv" style="font-size:12.5px;">
      <button class="entry-submit" style="margin-top:10px;" onclick="importFaturamentoXlsx()">Importar e substituir</button>
      <div id="eft-import-status" class="hint" style="margin-top:10px;"></div>
    </div>
    <hr style="margin:20px 0; border:none; border-top:1px solid var(--line);">
    <div class="hint" style="margin-bottom:4px;">Ou lance um contrato avulso manualmente:</div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px;">
      <label>Contrato<input type="text" id="eft-contrato" placeholder="Ex: 971"></label>
      <label>NF<input type="text" id="eft-nf" placeholder="Ex: 11 NF'S"></label>
      <label style="grid-column:1/-1;">Balsa/Viagem<input type="text" id="eft-balsa" list="dl-eft-balsa" placeholder="Ex: MELBOURNE - 16029"></label>
      <datalist id="dl-eft-balsa">${[...new Set(DATA.faturamento.lancamentos.map(r=>r.balsaViagem))].sort().map(l=>`<option value="${l}">`).join("")}</datalist>
      <label>Valor (R$)<input type="number" id="eft-valor" step="0.01" placeholder="0,00"></label>
      <label>Deadline<input type="date" id="eft-deadline"></label>
      <label>Vencimento<input type="date" id="eft-vencimento"></label>
      <label>Doc (opcional)<input type="text" id="eft-doc" placeholder="Ex: 0262"></label>
    </div>
    <button class="entry-submit" onclick="submitFaturamento()">Adicionar lançamento</button>
  `,
  belem: () => {
    const caixa = (titulo, descricao, idArquivo, idStatus, fn) => `
      <div style="background:var(--red-soft); border:1px solid #F0B9C0; border-radius:12px; padding:16px; margin-top:12px;">
        <h4 style="font-size:13px; margin-bottom:4px;">${titulo}</h4>
        <div class="hint" style="margin-bottom:10px;">${descricao}</div>
        <input type="file" id="${idArquivo}" accept=".xlsx,.xls,.csv" style="font-size:12.5px;">
        <button class="entry-submit" style="margin-top:10px;" onclick="${fn}()">Importar e substituir</button>
        <div id="${idStatus}" class="hint" style="margin-top:10px;"></div>
      </div>`;
    return `
    <div class="hint" style="margin-top:10px;">
      Cada planilha alimenta uma categoria de custo. Importar uma delas <b>substitui só aquela categoria</b> —
      as outras duas continuam como estão. O DRE do módulo Belém recalcula sozinho a cada importação.
    </div>
    ${caixa("⛽ Combustível",
      `Mesmo formato da planilha de Diesel de Manaus: aba <b>"Abastecimento"</b>, colunas DATA, PLACA, LITROS, VALOR POR VEÍCULO, POSTO.`,
      "eb-comb-file", "eb-comb-status", "importBelemCombustivelXlsx")}
    ${caixa("👷 Mão de Obra",
      `Mesmo formato da planilha de pagamento de salários: colunas <b>Mês</b>, VT + VR, AD. 40% e Salário (procura em qualquer aba).`,
      "eb-mo-file", "eb-mo-status", "importBelemMaoObraXlsx")}
    ${caixa("🧰 Peças",
      `Mesmo formato da planilha de compras de peças: aba <b>"Tabela"</b>, colunas CAMINHÃO, DATA DA COMPRA, PEÇA COMPRADAS, QTDE, TOTAL.`,
      "eb-pecas-file", "eb-pecas-status", "importBelemPecasXlsx")}
    <hr style="margin:20px 0; border:none; border-top:1px solid var(--line);">
    <div class="hint">
      A <b>Receita Bruta</b> começa em ${fmtBRL(RECEITA_BELEM_PADRAO)} por mês (valor do contrato) e é ajustada
      direto na tabela do DRE, dentro do módulo <b>Operação Belém</b>.
    </div>
  `;
  },
  compras: () => `
    <div style="background:var(--red-soft); border:1px solid #F0B9C0; border-radius:12px; padding:16px; margin-top:12px;">
      <h4 style="font-size:13px; margin-bottom:4px;">📤 Importar planilha (.xlsx)</h4>
      <div class="hint" style="margin-bottom:10px;">
        Lê a aba <b>"Tabela"</b> da planilha (se não encontrar, procura em qualquer aba). Colunas esperadas:
        CAMINHÃO, COMPRADOR, APROVADOR, DATA DA COMPRA, DATA DO VENC., LOCAL DA COMPRA, PEÇA COMPRADAS,
        CATEGORIA, NF, QTDE, VALOR UNIT., TOTAL, ANO, MÊS, SEMANA, TIPO DE MANUTENÇÃO — a mesma estrutura
        da sua planilha de controle de compras. Todas as linhas entram nos totais, mesmo quando
        "CAMINHÃO" é um centro de custo (ESTOQUE, PORTO, MANUTENÇÃO etc.) em vez de placa — essas só
        ficam de fora do ranking "Top 10 caminhões".<br>
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
    <div style="background:var(--red-soft); border:1px solid #F0B9C0; border-radius:12px; padding:16px; margin-top:12px;">
      <h4 style="font-size:13px; margin-bottom:4px;">📤 Importar planilha (.xlsx)</h4>
      <div class="hint" style="margin-bottom:10px;">
        Lê só a aba <b>"Abastecimento"</b> da planilha (a aba "Controle de Recebimento" é ignorada — essa
        é por caminhão, aquela é o total comprado do fornecedor). Colunas esperadas: DATA, PLACA, KM,
        LITROS, VALOR UNITÁRIO, VALOR POR VEÍCULO, MOTORISTA, POSTO, STATUS.<br>
        <b>Importar substitui todo o histórico de Diesel do sistema pelo conteúdo da aba Abastecimento.</b>
      </div>
      <input type="file" id="ed-import-file" accept=".xlsx,.xls,.csv" style="font-size:12.5px;">
      <button class="entry-submit" style="margin-top:10px;" onclick="importDieselXlsx()">Importar e substituir</button>
      <div id="ed-import-status" class="hint" style="margin-top:10px;"></div>
    </div>
    <hr style="margin:20px 0; border:none; border-top:1px solid var(--line);">
    <div class="hint" style="margin-bottom:4px;">Ou lance um abastecimento avulso manualmente:</div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px;">
      <label>Data<input type="date" id="ed-data" value="${new Date().toISOString().slice(0,10)}"></label>
      <label>Placa<input type="text" id="ed-placa" placeholder="Ex: GCV3D93"></label>
      <label>Litros<input type="number" id="ed-litros" step="0.01" placeholder="Ex: 150"></label>
      <label>Valor unitário (R$/L)<input type="number" id="ed-valorunit" step="0.01" placeholder="Ex: 5,55"></label>
    </div>
    <button class="entry-submit" onclick="submitDiesel()">Adicionar abastecimento</button>
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
    <div style="background:var(--red-soft); border:1px solid #F0B9C0; border-radius:12px; padding:16px; margin-top:12px;">
      <h4 style="font-size:13px; margin-bottom:4px;">📤 Importar planilha (.xlsx)</h4>
      <div class="hint" style="margin-bottom:10px;">
        Procura em todas as abas por uma linha de cabeçalho com <b>"Mês"</b> e <b>"Salário"</b>.
        Colunas esperadas: MÊS, VT + VR, AD. 40%, SALÁRIO (a coluna de total é ignorada — recalculada
        aqui como Ad.40% + Salário, igual ao resto do painel).<br>
        <b>Importar substitui todo o histórico de Folha do sistema pelo conteúdo da planilha.</b>
      </div>
      <input type="file" id="ef-import-file" accept=".xlsx,.xls,.csv" style="font-size:12.5px;">
      <button class="entry-submit" style="margin-top:10px;" onclick="importFolhaXlsx()">Importar e substituir</button>
      <div id="ef-import-status" class="hint" style="margin-top:10px;"></div>
    </div>
    <hr style="margin:20px 0; border:none; border-top:1px solid var(--line);">
    <div class="hint" style="margin-bottom:4px;">Ou lance/corrija um mês manualmente:</div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px;">
      <label>Mês (ex: jul/26)<input type="text" id="ef-mes" list="dl-folha-meses" placeholder="jul/26"></label>
      <datalist id="dl-folha-meses">${DATA.folha.labels.map(l=>`<option value="${l}">`).join("")}</datalist>
      <div></div>
      <label>VT + VR (R$)<input type="number" id="ef-vtvr" step="0.01" placeholder="Ex: 76000"></label>
      <label>40% Adicional (R$)<input type="number" id="ef-ad40" step="0.01" placeholder="Ex: 111300"></label>
      <label>Salário (R$)<input type="number" id="ef-salario" step="0.01" placeholder="Ex: 194200"></label>
    </div>
    <button class="entry-submit" onclick="submitFolha()">Adicionar / atualizar mês</button>
  `,
  horaextra: () => `
    <div style="background:var(--red-soft); border:1px solid #F0B9C0; border-radius:12px; padding:16px; margin-top:12px;">
      <h4 style="font-size:13px; margin-bottom:4px;">📤 Importar planilha de Hora Extra (.xlsx)</h4>
      <div class="hint" style="margin-bottom:10px;">
        Lê a aba <b>"DADOS 2025-2026"</b> do Controle de Hora Extra (em R$). Colunas esperadas:
        COLABORADOR, MÊS, FUNÇÃO, H.E 20%, H.E 50%, H.E 100%, DISSIDIO MAIO, DISSIDIO 50%, TOTAL e Ano.
        O ano vem da coluna <b>Ano</b> (a data da coluna MÊS é usada só para o mês).
        <b>Importar substitui todo o histórico de hora extra do sistema.</b>
      </div>
      <input type="file" id="ehe-import-file" accept=".xlsx,.xls" style="font-size:12.5px;">
      <button class="entry-submit" style="margin-top:10px;" onclick="importHoraExtraXlsx()">Importar e substituir</button>
      <div id="ehe-import-status" class="hint" style="margin-top:10px;"></div>
    </div>
    <h4 style="font-size:13px; margin-top:18px;">Lançamento manual mensal</h4>
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
    <div style="background:var(--red-soft); border:1px solid #F0B9C0; border-radius:12px; padding:16px; margin-top:12px;">
      <h4 style="font-size:13px; margin-bottom:4px;">📤 Importar planilha (.xlsx)</h4>
      <div class="hint" style="margin-bottom:10px;">
        Lê a aba <b>"LANÇAMENTOS"</b> do Controle de Atestados/Afastamentos. Colunas esperadas:
        DATA, COLABORADOR, MOTIVO / CID, HORAS, DIAS, CATEGORIA, DATA RETORNO, OBSERVAÇÃO
        (ID, ANO, MÊS Nº e MÊS são ignoradas — o painel calcula isso a partir da própria data).
        As abas de resumo da planilha (DASHBOARD, CONTROLE MENSAL, FALTAS POR MOTIVO) também são
        ignoradas: o painel refaz esses cálculos sozinho.<br>
        <b>Importar substitui todo o histórico de Atestados do sistema pelo conteúdo da aba LANÇAMENTOS.</b>
      </div>
      <input type="file" id="eat-import-file" accept=".xlsx,.xls,.csv" style="font-size:12.5px;">
      <button class="entry-submit" style="margin-top:10px;" onclick="importAtestadosXlsx()">Importar e substituir</button>
      <div id="eat-import-status" class="hint" style="margin-top:10px;"></div>
    </div>
    <hr style="margin:20px 0; border:none; border-top:1px solid var(--line);">
    <div class="hint" style="margin-bottom:4px;">Ou atualize só o total de ocorrências de um mês (forma antiga, sem detalhe por pessoa):</div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px;">
      <label>Mês (ex: jun/26)<input type="text" id="ea-mes" list="dl-atest-meses" placeholder="jun/26"></label>
      <datalist id="dl-atest-meses">${DATA.atestados.labels.map(l=>`<option value="${l}">`).join("")}</datalist>
      <label>Ocorrências<input type="number" id="ea-valor" step="1" placeholder="Ex: 18"></label>
    </div>
    <button class="entry-submit" onclick="submitAtestado()">Adicionar / atualizar mês</button>
  `,
  infracoes: () => `
    <div style="background:var(--red-soft); border:1px solid #F0B9C0; border-radius:12px; padding:16px; margin-top:12px;">
      <h4 style="font-size:13px; margin-bottom:4px;">📤 Importar planilha (.xlsx)</h4>
      <div class="hint" style="margin-bottom:10px;">
        Lê só a aba <b>"Matriz"</b> da planilha (as outras abas são ignoradas). Colunas esperadas nela:
        DATA, MOTORISTA, PLACA, TURNO, HORA, OCORRÊNCIA, OBSERVAÇÕES DO MONITORAMENTO (a coluna MÊS é
        ignorada — o mês de cada ocorrência é calculado a partir da própria data).<br>
        <b>Importar substitui todo o histórico de Infrações do sistema pelo conteúdo da aba Matriz.</b>
      </div>
      <input type="file" id="ei-import-file" accept=".xlsx,.xls,.csv" style="font-size:12.5px;">
      <button class="entry-submit" style="margin-top:10px;" onclick="importInfracoesXlsx()">Importar e substituir</button>
      <div id="ei-import-status" class="hint" style="margin-top:10px;"></div>
    </div>
    <hr style="margin:20px 0; border:none; border-top:1px solid var(--line);">
    <div class="hint" style="margin-bottom:4px;">Ou lance uma ocorrência avulsa manualmente:</div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px;">
      <label>Data<input type="date" id="ei-data" value="${new Date().toISOString().slice(0,10)}"></label>
      <label>Hora<input type="time" id="ei-hora"></label>
      <label>Motorista<input type="text" id="ei-motorista" list="dl-inf-motoristas" placeholder="Ex: LEANDRO DA SILVA MARINHO"></label>
      <datalist id="dl-inf-motoristas">${[...new Set(DATA.infracoes.lancamentos.map(r=>r.motorista))].sort().map(l=>`<option value="${l}">`).join("")}</datalist>
      <label>Placa<input type="text" id="ei-placa" placeholder="Ex: GCV-0274"></label>
      <label>Turno<select id="ei-turno"><option value="1">1º Turno</option><option value="2">2º Turno</option></select></label>
      <label style="grid-column:1/-1;">Ocorrência<input type="text" id="ei-ocorrencia" list="dl-inf-ocorrencias" placeholder="Ex: Direção distraída"></label>
      <datalist id="dl-inf-ocorrencias">${TIPOS_OCORRENCIA.map(t=>`<option value="${t}">`).join("")}</datalist>
      <label style="grid-column:1/-1;">Observações do Monitoramento (opcional)<input type="text" id="ei-obs" placeholder="Ex: Uso de Celular"></label>
    </div>
    <button class="entry-submit" onclick="submitInfracao()">Adicionar ocorrência</button>
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
  if(PAGINAS_SO_DIRETOR.includes(mod) && MEU_PAPEL !== "diretor") mod = entryModulesVisiveis()[0].key;
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

// Nome do mês por extenso, em português (algumas linhas da planilha de Faturamento trazem a data
// digitada como "sexta-feira, 16 de janeiro de 2026" em vez de data de verdade).
const MESES_PT_PARA_NUM = { janeiro:1, fevereiro:2, "março":3, marco:3, abril:4, maio:5, junho:6,
  julho:7, agosto:8, setembro:9, outubro:10, novembro:11, dezembro:12 };

// Converte data do Excel (Date object, já que lemos com cellDates:true) para "YYYY-MM-DD" local, sem shift de fuso.
function excelDateToISO(d){
  if(d instanceof Date && !isNaN(d)){
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,"0"), day = String(d.getDate()).padStart(2,"0");
    return `${y}-${m}-${day}`;
  }
  // Algumas linhas trazem a data como texto "DD/MM/AAAA" ou "DD-MM-AAAA" em vez de data de verdade
  // (comum quando a célula foi digitada/colada manualmente na planilha) — aceita os dois formatos.
  if(typeof d === "string"){
    const m = d.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if(m){
      let [, dd, mm, yyyy] = m;
      if(yyyy.length === 2) yyyy = (Number(yyyy) < 50 ? "20" : "19") + yyyy;
      return `${yyyy}-${mm.padStart(2,"0")}-${dd.padStart(2,"0")}`;
    }
    // ...ou por extenso, ex: "sexta-feira, 16 de janeiro de 2026" (visto na planilha de Faturamento).
    const mExt = d.trim().toLowerCase().match(/(\d{1,2})\s+de\s+([a-zçã]+)\s+de\s+(\d{4})/);
    if(mExt){
      const [, dd, mesNome, yyyy] = mExt;
      const mesNum = MESES_PT_PARA_NUM[mesNome];
      if(mesNum) return `${yyyy}-${String(mesNum).padStart(2,"0")}-${dd.padStart(2,"0")}`;
    }
  }
  return null;
}

// Converte hora do Excel (Date "1899-12-30 HH:MM" já que lemos com cellDates:true, fração do dia
// em número, ou texto "HH:MM"/"HH;MM" — esse último apareceu em algumas linhas digitadas na mão) para "HH:MM".
function excelTimeToHHMM(v){
  if(v == null || v === "") return "";
  if(v instanceof Date && !isNaN(v)){
    return String(v.getHours()).padStart(2,"0") + ":" + String(v.getMinutes()).padStart(2,"0");
  }
  if(typeof v === "number"){
    const totalMin = Math.round(v * 24 * 60);
    return String(Math.floor(totalMin/60) % 24).padStart(2,"0") + ":" + String(totalMin % 60).padStart(2,"0");
  }
  const m = String(v).trim().match(/^(\d{1,2})[:;h](\d{2})/);
  return m ? (m[1].padStart(2,"0") + ":" + m[2]) : String(v).trim();
}

// Abreviação de mês (3 letras, PT ou EN — a planilha de Folha teve pelo menos uma linha digitada
// como "feb/26" em vez de data de verdade) para o número do mês (1-12).
const MESES_ABBR_PARA_NUM = { jan:1, fev:2, feb:2, mar:3, abr:4, apr:4, mai:5, may:5, jun:6, jul:7,
  ago:8, aug:8, set:9, sep:9, out:10, oct:10, nov:11, dez:12, dec:12 };
// Converte a coluna "Mês" da planilha de Folha (Date de verdade, ou texto "abr/26"/"apr/26") em
// { ano, mes } — devolve null se não conseguir reconhecer o formato.
function parseMesFolha(v){
  if(v instanceof Date && !isNaN(v)) return { ano:v.getFullYear(), mes:v.getMonth()+1 };
  if(typeof v === "string"){
    const m = v.trim().toLowerCase().match(/^([a-z]{3})[\/\-](\d{2,4})$/);
    if(m && MESES_ABBR_PARA_NUM[m[1]]){
      let ano = parseInt(m[2],10);
      if(m[2].length === 2) ano = 2000 + ano;
      return { ano, mes: MESES_ABBR_PARA_NUM[m[1]] };
    }
  }
  return null;
}

window.importFolhaXlsx = async () => {
  const fileInput = document.getElementById("ef-import-file");
  const statusEl = document.getElementById("ef-import-status");
  const file = fileInput.files[0];
  if(!file){ statusEl.textContent = "⚠ Selecione um arquivo primeiro."; return; }
  if(typeof XLSX === "undefined"){ statusEl.textContent = "⚠ Biblioteca de planilhas não carregada (confira se xlsx.full.min.js está na pasta)."; return; }

  statusEl.textContent = "Lendo planilha...";
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type:"array", cellDates:true });

    // Essa planilha costuma ter só uma aba sem nome descritivo — em vez de mirar um nome fixo,
    // procura em TODAS as abas pela linha de cabeçalho (precisa ter "MÊS" e "SALÁRIO" juntos).
    let headerRow = null, sheetRows = null;
    for(const nome of wb.SheetNames){
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header:1, defval:null });
      for(let i=0;i<Math.min(rows.length,15);i++){
        const r = rows[i];
        if(r && r.some(c=>c!=null && ["MÊS","MES"].includes(String(c).trim().toUpperCase()))
             && r.some(c=>c!=null && String(c).trim().toUpperCase().startsWith("SAL"))){
          headerRow = r; sheetRows = rows.slice(i+1); break;
        }
      }
      if(headerRow) break;
    }
    if(!headerRow){
      statusEl.textContent = "⚠ Não encontrei a linha de cabeçalho (esperava colunas 'Mês' e 'Salário'). Confira se é a mesma estrutura do seu relatório.";
      return;
    }

    const idx = {};
    headerRow.forEach((h,i)=>{ if(h!=null) idx[String(h).trim().toUpperCase()] = i; });
    const col = (name) => idx[name];
    const cMes = col("MÊS") ?? col("MES");
    const cVtVr = col("VT + VR") ?? col("VT+VR");
    const cAd40 = col("AD. 40%") ?? col("AD.40%") ?? col("AD 40%");
    const cSalario = col("SALÁRIO") ?? col("SALARIO");
    if(cMes==null || cSalario==null){
      statusEl.textContent = "⚠ Faltam colunas essenciais (MÊS ou SALÁRIO). Confira o cabeçalho da planilha.";
      return;
    }

    const porMes = {}; // "ano-mes" -> {ano, mes, vtVr, ad40, salario}
    let ignoradas = 0;
    sheetRows.forEach(r=>{
      if(!r) return;
      const mesInfo = parseMesFolha(r[cMes]);
      if(!mesInfo){ if(r[cMes]!=null) ignoradas++; return; }
      const vtVrRaw = cVtVr!=null ? r[cVtVr] : null, ad40Raw = cAd40!=null ? r[cAd40] : null, salarioRaw = r[cSalario];
      const vtVr = (vtVrRaw!=null && vtVrRaw!=="") ? parseValorBRL(vtVrRaw) : null;
      const ad40 = (ad40Raw!=null && ad40Raw!=="") ? parseValorBRL(ad40Raw) : null;
      const salario = (salarioRaw!=null && salarioRaw!=="") ? parseValorBRL(salarioRaw) : null;
      const chave = mesInfo.ano + "-" + String(mesInfo.mes).padStart(2,"0");
      porMes[chave] = { ano:mesInfo.ano, mes:mesInfo.mes,
        vtVr: isNaN(vtVr) ? null : vtVr, ad40: isNaN(ad40) ? null : ad40, salario: isNaN(salario) ? null : salario };
    });

    let chaves = Object.keys(porMes).sort();
    if(chaves.length === 0){
      statusEl.textContent = "⚠ Nenhum mês válido encontrado na planilha.";
      return;
    }
    // Corta meses futuros totalmente vazios (planilha costuma ter linhas placeholder pro resto do
    // ano) do FIM da lista — mas só enquanto os 3 campos estiverem vazios; um mês com pelo menos
    // um valor preenchido (mesmo que parcial) fica.
    while(chaves.length > 0){
      const ultimo = porMes[chaves[chaves.length-1]];
      if(ultimo.vtVr==null && ultimo.ad40==null && ultimo.salario==null) chaves.pop();
      else break;
    }
    if(chaves.length === 0){
      statusEl.textContent = "⚠ Nenhum mês com valor preenchido encontrado na planilha.";
      return;
    }

    const novosLabels = chaves.map(k=>{ const m = porMes[k]; return MONTH_ABBR[m.mes-1] + "/" + String(m.ano).slice(2); });
    const novosVtVr = chaves.map(k=>porMes[k].vtVr);
    const novosAd40 = chaves.map(k=>porMes[k].ad40);
    const novosSalario = chaves.map(k=>porMes[k].salario);

    const anteriores = { labels:[...DATA.folha.labels], vtVr:[...DATA.folha.vtVr], ad40:[...DATA.folha.ad40], salario:[...DATA.folha.salario] };
    DATA.folha.labels = novosLabels;
    DATA.folha.vtVr = novosVtVr;
    DATA.folha.ad40 = novosAd40;
    DATA.folha.salario = novosSalario;
    recomputeFolha();
    logEntry("Folha (importação)", `${chaves.length} meses importados de "${file.name}"`, { kind:"bulkImportFolha", anteriores });
    renderSessionLog();

    let statusMsg = `✓ <b>${fmtNum(chaves.length)}</b> meses importados (${novosLabels[0]} a ${novosLabels[novosLabels.length-1]}).` +
      (ignoradas>0 ? `<br>${ignoradas} linha(s) com "Mês" não reconhecido foram ignoradas.` : "");
    statusEl.innerHTML = statusMsg;

    if(document.querySelector('nav.menu button.active')?.dataset.page === "folha") navigate("folha");

    if(sb){
      statusEl.innerHTML = statusMsg + "<br>Substituindo no banco de dados...";
      const { error: delError } = await sb.from("series_periodo").delete().eq("modulo","folha");
      if(delError){ statusEl.innerHTML = statusMsg + "<br>⚠ Salvo aqui, mas falhou ao limpar o banco: " + delError.message; return; }
      try{
        const rows = [];
        chaves.forEach((k,i)=>{
          if(novosVtVr[i]!=null) rows.push({ modulo:"folha", campo:"vtVr", label:novosLabels[i], valor:novosVtVr[i] });
          if(novosAd40[i]!=null) rows.push({ modulo:"folha", campo:"ad40", label:novosLabels[i], valor:novosAd40[i] });
          if(novosSalario[i]!=null) rows.push({ modulo:"folha", campo:"salario", label:novosLabels[i], valor:novosSalario[i] });
        });
        await sbBulkInsert("series_periodo", rows);
        statusEl.innerHTML = statusMsg + "<br>✓ Banco de dados atualizado — todo mundo que abrir o link já vê essa importação.";
        toast(`✓ ${chaves.length} meses importados (salvo no banco)`);
      }catch(e){
        statusEl.innerHTML = statusMsg + "<br>⚠ Salvo aqui, mas falhou ao gravar no banco: " + e.message;
      }
    } else {
      toast(`✓ ${chaves.length} meses importados`);
    }
  }catch(e){
    console.error(e);
    statusEl.textContent = "⚠ Erro ao ler o arquivo: " + e.message;
  }
};

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

    // Só a aba "Tabela" é importada — mira o nome específico em vez de confiar na ordem das abas
    // (mesma lógica usada em Manutenção/Diesel). Se não achar "Tabela", cai pra busca antiga por
    // qualquer aba que comece com "CAMINHÃO" na primeira coluna, pra não quebrar planilhas antigas.
    let headerRow = null, sheetRows = null;
    const nomeAbaTabela = wb.SheetNames.find(n=>n.trim().toUpperCase()==="TABELA");
    const sheetsParaBuscar = nomeAbaTabela ? [nomeAbaTabela] : wb.SheetNames;
    for(const name of sheetsParaBuscar){
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
      statusEl.textContent = "⚠ Não encontrei a linha de cabeçalho (esperava uma coluna 'CAMINHÃO') na aba Tabela. Confira se é a mesma estrutura da planilha de controle.";
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
    let ignoradas = 0;
    sheetRows.forEach(r=>{
      if(!r) return;
      const dataRaw = r[cData], total = r[cTotal];
      if(dataRaw == null || total == null || total === "") { ignoradas++; return; }
      const iso = excelDateToISO(dataRaw);
      if(!iso){ ignoradas++; return; }
      const placa = normalizarPlaca(r[cCam]);
      const valor = parseValorBRL(total);
      if(isNaN(valor)){ ignoradas++; return; }
      // Coluna "CAMINHÃO" mistura placa de verdade com centro de custo (ESTOQUE, ESCRITÓRIO,
      // PORTO, MANUTENÇÃO etc.) — entra tudo nos totais/categorias, só não entra no ranking de
      // Top 10 caminhões (ver pareceCaminhao() em computarComprasStats).
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
    const semPlacaVeiculo = novos.filter(r=>!pareceCaminhao(r.p)).length;
    let statusMsg = `✓ <b>${fmtNum(novos.length)}</b> lançamentos importados (${datas[0].split("-").reverse().join("/")} a ${datas[datas.length-1].split("-").reverse().join("/")}), total ${fmtBRL(novos.reduce((s,r)=>s+r.v,0))}.` +
      (semPlacaVeiculo>0 ? `<br>${semPlacaVeiculo} linha(s) com "CAMINHÃO" preenchido como centro de custo (ex: ESTOQUE, PORTO, MANUTENÇÃO) entram nos totais mas ficam de fora do ranking Top 10 caminhões.` : "") +
      (ignoradas>0 ? `<br>${ignoradas} linha(s) sem data ou valor válido foram ignoradas.` : "");
    statusEl.innerHTML = statusMsg;

    if(document.querySelector('nav.menu button.active')?.dataset.page === "compras") navigate("compras");

    if(sb){
      statusEl.innerHTML = statusMsg + "<br>Gravando no banco de dados...";
      try{
        await sbSubstituirTabela("compras_lancamentos", novos.map(r=>({ data:r.d, placa:r.p, local:r.l, categoria:r.c, item:r.i, valor:r.v })));
        statusEl.innerHTML = statusMsg + "<br>✓ Banco de dados atualizado — todo mundo que abrir o link já vê essa importação.";
        toast(`✓ ${novos.length} lançamentos importados (salvo no banco)`);
      }catch(e){
        statusEl.innerHTML = statusMsg + avisoFalhaGravacao(e);
        toast("⚠ A importação NÃO foi salva no banco — veja o aviso na tela");
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
      statusEl.innerHTML = statusMsg + "<br>Gravando no banco de dados...";
      try{
        await sbSubstituirTabela("manutencao_lancamentos", novos.map(r=>({ data:r.d, placa:r.placa, local:r.local, nf:r.nf, os:r.os, frota:r.frota, servico:r.servico, status:r.status, valor:r.v })));
        statusEl.innerHTML = statusMsg + "<br>✓ Banco de dados atualizado — todo mundo que abrir o link já vê essa importação.";
        toast(`✓ ${novos.length} lançamentos importados (salvo no banco)`);
      }catch(e){
        statusEl.innerHTML = statusMsg + avisoFalhaGravacao(e);
        toast("⚠ A importação NÃO foi salva no banco — veja o aviso na tela");
      }
    } else {
      toast(`✓ ${novos.length} lançamentos importados`);
    }
  }catch(e){
    console.error(e);
    statusEl.textContent = "⚠ Erro ao ler o arquivo: " + e.message;
  }
};

window.importDieselXlsx = async () => {
  const fileInput = document.getElementById("ed-import-file");
  const statusEl = document.getElementById("ed-import-status");
  const file = fileInput.files[0];
  if(!file){ statusEl.textContent = "⚠ Selecione um arquivo primeiro."; return; }
  if(typeof XLSX === "undefined"){ statusEl.textContent = "⚠ Biblioteca de planilhas não carregada (confira se xlsx.full.min.js está na pasta)."; return; }

  statusEl.textContent = "Lendo planilha...";
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type:"array", cellDates:true });

    // Só a aba "Abastecimento" (por caminhão) é importada — "Controle de Recebimento" (compra do
    // fornecedor, sem placa) fica de fora de propósito.
    const nomeAbaAlvo = wb.SheetNames.find(n=>n.trim().toUpperCase()==="ABASTECIMENTO");
    if(!nomeAbaAlvo){
      statusEl.textContent = `⚠ Não encontrei uma aba chamada "Abastecimento" nesta planilha. Abas encontradas: ${wb.SheetNames.join(", ")}.`;
      return;
    }

    const rows = XLSX.utils.sheet_to_json(wb.Sheets[nomeAbaAlvo], { header:1, defval:null });
    let headerRow = null, sheetRows = null;
    for(let i=0;i<Math.min(rows.length,30);i++){
      const r = rows[i];
      if(r && r.some(c=>c!=null && String(c).trim().toUpperCase()==="PLACA")){
        headerRow = r; sheetRows = rows.slice(i+1); break;
      }
    }
    if(!headerRow){
      statusEl.textContent = "⚠ Não encontrei a linha de cabeçalho (esperava uma coluna 'Placa') na aba Abastecimento. Confira se é a mesma estrutura do seu relatório.";
      return;
    }

    const idx = {};
    headerRow.forEach((h,i)=>{ if(h!=null) idx[String(h).trim().toUpperCase()] = i; });
    const col = (colName) => idx[colName];
    const cData = col("DATA"), cPlaca = col("PLACA"), cKm = col("KM"), cLitros = col("LITROS"),
          cValorUnit = col("VALOR UNITÁRIO"), cValor = col("VALOR POR VEÍCULO") ?? col("VALOR"),
          cMotorista = col("MOTORISTA"), cPosto = col("POSTO"), cStatus = col("STATUS");
    if(cData==null || cPlaca==null || cLitros==null){
      statusEl.textContent = "⚠ Faltam colunas essenciais (DATA, PLACA ou LITROS) na aba Abastecimento. Confira o cabeçalho da planilha.";
      return;
    }

    const novos = [];
    let ignoradas = 0;
    sheetRows.forEach(r=>{
      if(!r) return;
      const dataRaw = r[cData], litrosRaw = r[cLitros];
      if(dataRaw == null || litrosRaw == null || litrosRaw === "") { ignoradas++; return; }
      const iso = excelDateToISO(dataRaw);
      if(!iso){ ignoradas++; return; }
      const litros = parseValorBRL(litrosRaw);
      if(isNaN(litros)){ ignoradas++; return; }
      const valorUnit = cValorUnit!=null ? parseValorBRL(r[cValorUnit]) : NaN;
      let valor = cValor!=null ? parseValorBRL(r[cValor]) : NaN;
      if(isNaN(valor) && !isNaN(valorUnit)) valor = litros * valorUnit; // fallback: calcula se a coluna de total estiver vazia
      if(isNaN(valor)){ ignoradas++; return; }
      novos.push({
        id: localId(),
        d: iso,
        placa: (r[cPlaca]||"").toString().trim(),
        km: (cKm!=null && r[cKm]!=null) ? r[cKm] : null,
        litros,
        valorUnit: isNaN(valorUnit) ? null : valorUnit,
        motorista: (cMotorista!=null ? (r[cMotorista]||"").toString().trim() : ""),
        posto: (cPosto!=null ? (r[cPosto]||"").toString().trim() : ""),
        status: (cStatus!=null ? (r[cStatus]||"").toString().trim() : ""),
        v: valor
      });
    });

    if(novos.length === 0){
      statusEl.textContent = "⚠ Nenhum lançamento válido encontrado na planilha.";
      return;
    }

    const anteriores = DATA.diesel.lancamentos;
    DATA.diesel.lancamentos = novos;
    deriveDiesel();
    logEntry("Diesel (importação)", `${novos.length} abastecimentos importados de "${file.name}"`, { kind:"bulkImportDiesel", anteriores });
    renderSessionLog();

    const datas = novos.map(r=>r.d).sort();
    let statusMsg = `✓ <b>${fmtNum(novos.length)}</b> abastecimentos importados (${datas[0].split("-").reverse().join("/")} a ${datas[datas.length-1].split("-").reverse().join("/")}), total ${fmtBRL(novos.reduce((s,r)=>s+r.v,0))}.` +
      (ignoradas>0 ? `<br>${ignoradas} linha(s) sem data ou litros válidos foram ignoradas.` : "");
    statusEl.innerHTML = statusMsg;

    if(document.querySelector('nav.menu button.active')?.dataset.page === "diesel") navigate("diesel");

    if(sb){
      statusEl.innerHTML = statusMsg + "<br>Gravando no banco de dados...";
      try{
        await sbSubstituirTabela("diesel_abastecimentos", novos.map(r=>({ data:r.d, placa:r.placa, km:r.km, litros:r.litros, valor_unitario:r.valorUnit, valor:r.v, motorista:r.motorista, posto:r.posto, status:r.status })));
        statusEl.innerHTML = statusMsg + "<br>✓ Banco de dados atualizado — todo mundo que abrir o link já vê essa importação.";
        toast(`✓ ${novos.length} abastecimentos importados (salvo no banco)`);
      }catch(e){
        statusEl.innerHTML = statusMsg + avisoFalhaGravacao(e);
        toast("⚠ A importação NÃO foi salva no banco — veja o aviso na tela");
      }
    } else {
      toast(`✓ ${novos.length} abastecimentos importados`);
    }
  }catch(e){
    console.error(e);
    statusEl.textContent = "⚠ Erro ao ler o arquivo: " + e.message;
  }
};

window.importInfracoesXlsx = async () => {
  const fileInput = document.getElementById("ei-import-file");
  const statusEl = document.getElementById("ei-import-status");
  const file = fileInput.files[0];
  if(!file){ statusEl.textContent = "⚠ Selecione um arquivo primeiro."; return; }
  if(typeof XLSX === "undefined"){ statusEl.textContent = "⚠ Biblioteca de planilhas não carregada (confira se xlsx.full.min.js está na pasta)."; return; }

  statusEl.textContent = "Lendo planilha...";
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type:"array", cellDates:true });

    // Só a aba "Matriz" é importada — mesma convenção usada em Manutenção de Carreta.
    const nomeAbaAlvo = wb.SheetNames.find(n=>n.trim().toUpperCase()==="MATRIZ");
    if(!nomeAbaAlvo){
      statusEl.textContent = `⚠ Não encontrei uma aba chamada "Matriz" nesta planilha. Abas encontradas: ${wb.SheetNames.join(", ")}.`;
      return;
    }

    const rows = XLSX.utils.sheet_to_json(wb.Sheets[nomeAbaAlvo], { header:1, defval:null });
    let headerRow = null, sheetRows = null;
    for(let i=0;i<Math.min(rows.length,30);i++){
      const r = rows[i];
      if(r && r.some(c=>c!=null && String(c).trim().toUpperCase()==="MOTORISTA")){
        headerRow = r; sheetRows = rows.slice(i+1); break;
      }
    }
    if(!headerRow){
      statusEl.textContent = "⚠ Não encontrei a linha de cabeçalho (esperava uma coluna 'Motorista') na aba Matriz. Confira se é a mesma estrutura do seu relatório.";
      return;
    }

    const idx = {};
    headerRow.forEach((h,i)=>{ if(h!=null) idx[String(h).trim().toUpperCase()] = i; });
    const col = (name) => idx[name];
    const cData = col("DATA"), cMotorista = col("MOTORISTA"), cPlaca = col("PLACA"), cTurno = col("TURNO"),
          cHora = col("HORA"), cOcorrencia = col("OCORRÊNCIA") ?? col("OCORRENCIA"),
          cObs = col("OBSERVAÇÕES DO MONITORAMENTO") ?? col("OBSERVACOES DO MONITORAMENTO");
    if(cData==null || cMotorista==null || cOcorrencia==null){
      statusEl.textContent = "⚠ Faltam colunas essenciais (DATA, MOTORISTA ou OCORRÊNCIA) na aba Matriz. Confira o cabeçalho da planilha.";
      return;
    }

    const novos = [];
    let ignoradas = 0;
    sheetRows.forEach(r=>{
      if(!r) return;
      const dataRaw = r[cData], ocorrenciaRaw = r[cOcorrencia];
      if(dataRaw == null || ocorrenciaRaw == null || String(ocorrenciaRaw).trim()===""){ ignoradas++; return; }
      const iso = excelDateToISO(dataRaw);
      if(!iso){ ignoradas++; return; }
      const turnoMatch = cTurno!=null ? String(r[cTurno]||"").match(/(\d)/) : null;
      novos.push({
        id: localId(),
        d: iso,
        motorista: (cMotorista!=null ? (r[cMotorista]||"").toString().trim() : ""),
        placa: (cPlaca!=null ? (r[cPlaca]||"").toString().trim() : ""),
        turno: turnoMatch ? turnoMatch[1] : "",
        hora: cHora!=null ? excelTimeToHHMM(r[cHora]) : "",
        ocorrencia: String(ocorrenciaRaw).trim(),
        observacoes: (cObs!=null && r[cObs]!=null) ? String(r[cObs]).trim() : ""
      });
    });

    if(novos.length === 0){
      statusEl.textContent = "⚠ Nenhuma ocorrência válida encontrada na planilha.";
      return;
    }

    const anteriores = DATA.infracoes.lancamentos;
    DATA.infracoes.lancamentos = novos;
    deriveInfracoes();
    logEntry("Infrações (importação)", `${novos.length} ocorrências importadas de "${file.name}"`, { kind:"bulkImportInfracoes", anteriores });
    renderSessionLog();

    const datas = novos.map(r=>r.d).sort();
    let statusMsg = `✓ <b>${fmtNum(novos.length)}</b> ocorrências importadas (${datas[0].split("-").reverse().join("/")} a ${datas[datas.length-1].split("-").reverse().join("/")}).` +
      (ignoradas>0 ? `<br>${ignoradas} linha(s) sem data ou ocorrência válida foram ignoradas.` : "");
    statusEl.innerHTML = statusMsg;

    if(document.querySelector('nav.menu button.active')?.dataset.page === "infracoes") navigate("infracoes");

    if(sb){
      statusEl.innerHTML = statusMsg + "<br>Gravando no banco de dados...";
      try{
        await sbSubstituirTabela("infracoes_lancamentos", novos.map(r=>({ data:r.d, motorista:r.motorista, placa:r.placa, turno:r.turno, hora:r.hora||null, ocorrencia:r.ocorrencia, observacoes:r.observacoes||null })));
        statusEl.innerHTML = statusMsg + "<br>✓ Banco de dados atualizado — todo mundo que abrir o link já vê essa importação.";
        toast(`✓ ${novos.length} ocorrências importadas (salvo no banco)`);
      }catch(e){
        statusEl.innerHTML = statusMsg + avisoFalhaGravacao(e);
        toast("⚠ A importação NÃO foi salva no banco — veja o aviso na tela");
      }
    } else {
      toast(`✓ ${novos.length} ocorrências importadas`);
    }
  }catch(e){
    console.error(e);
    statusEl.textContent = "⚠ Erro ao ler o arquivo: " + e.message;
  }
};

window.importEntregasXlsx = async () => {
  const fileInput = document.getElementById("eg-import-file");
  const statusEl = document.getElementById("eg-import-status");
  const file = fileInput.files[0];
  if(!file){ statusEl.textContent = "⚠ Selecione um arquivo primeiro."; return; }
  if(typeof XLSX === "undefined"){ statusEl.textContent = "⚠ Biblioteca de planilhas não carregada (confira se xlsx.full.min.js está na pasta)."; return; }

  statusEl.textContent = "Lendo planilha...";
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type:"array", cellDates:true });

    // Só a aba "MATRIZ" é importada — mesma convenção usada em Manutenção/Infrações.
    const nomeAbaAlvo = wb.SheetNames.find(n=>n.trim().toUpperCase()==="MATRIZ");
    if(!nomeAbaAlvo){
      statusEl.textContent = `⚠ Não encontrei uma aba chamada "MATRIZ" nesta planilha. Abas encontradas: ${wb.SheetNames.join(", ")}.`;
      return;
    }

    const rows = XLSX.utils.sheet_to_json(wb.Sheets[nomeAbaAlvo], { header:1, defval:null });
    let headerRow = null, sheetRows = null;
    for(let i=0;i<Math.min(rows.length,30);i++){
      const r = rows[i];
      if(r && r.some(c=>c!=null && String(c).trim().toUpperCase()==="CLIENTE") && r.some(c=>c!=null && String(c).trim().toUpperCase()==="TRANSPORTADORA")){
        headerRow = r; sheetRows = rows.slice(i+1); break;
      }
    }
    if(!headerRow){
      statusEl.textContent = "⚠ Não encontrei a linha de cabeçalho (esperava colunas 'Cliente' e 'Transportadora') na aba MATRIZ. Confira se é a mesma estrutura do seu relatório.";
      return;
    }

    const idx = {};
    headerRow.forEach((h,i)=>{ if(h!=null) idx[String(h).trim().toUpperCase()] = i; });
    const col = (name) => idx[name];
    const cData = col("DATA"), cServico = col("SERVIÇO") ?? col("SERVICO"), cTransp = col("TRANSPORTADORA"),
          cCliente = col("CLIENTE"), cMotorista = col("MOTORISTA"), cCarro = col("CARRO"), cQnt = col("QNT"),
          cValor = col("VALOR"), cObs = col("OBSERVAÇÃO") ?? col("OBSERVACAO");
    if(cData==null || cValor==null){
      statusEl.textContent = "⚠ Faltam colunas essenciais (DATA ou VALOR) na aba MATRIZ. Confira o cabeçalho da planilha.";
      return;
    }

    const novos = [];
    let ignoradas = 0;
    sheetRows.forEach(r=>{
      if(!r) return;
      const dataRaw = r[cData], valorRaw = r[cValor];
      if(dataRaw == null || valorRaw == null || valorRaw === ""){ ignoradas++; return; }
      const iso = excelDateToISO(dataRaw);
      if(!iso){ ignoradas++; return; }
      const valor = parseValorBRL(valorRaw);
      if(isNaN(valor)){ ignoradas++; return; }
      const qntRaw = cQnt!=null ? r[cQnt] : null;
      const qnt = (qntRaw!=null && qntRaw!=="") ? (parseInt(qntRaw,10) || 1) : 1;
      novos.push({
        id: localId(),
        d: iso,
        servico: (cServico!=null && r[cServico]!=null && String(r[cServico]).trim()!=="") ? String(r[cServico]).trim().toUpperCase() : "(Em branco)",
        transportadora: (cTransp!=null ? (r[cTransp]||"").toString().trim() : ""),
        cliente: (cCliente!=null ? (r[cCliente]||"").toString().trim() : ""),
        motorista: (cMotorista!=null ? (r[cMotorista]||"").toString().trim() : ""),
        carro: (cCarro!=null ? (r[cCarro]||"").toString().trim() : ""),
        qnt,
        v: valor,
        observacao: (cObs!=null && r[cObs]!=null) ? String(r[cObs]).trim() : ""
      });
    });

    if(novos.length === 0){
      statusEl.textContent = "⚠ Nenhuma operação válida encontrada na planilha.";
      return;
    }

    const anteriores = DATA.entregas.lancamentos;
    DATA.entregas.lancamentos = novos;
    deriveEntregas();
    logEntry("Entregas (importação)", `${novos.length} operações importadas de "${file.name}"`, { kind:"bulkImportEntregas", anteriores });
    renderSessionLog();

    const datas = novos.map(r=>r.d).sort();
    let statusMsg = `✓ <b>${fmtNum(novos.length)}</b> operações importadas (${datas[0].split("-").reverse().join("/")} a ${datas[datas.length-1].split("-").reverse().join("/")}), total ${fmtBRL(novos.reduce((s,r)=>s+r.v,0))}.` +
      (ignoradas>0 ? `<br>${ignoradas} linha(s) sem data ou valor válido foram ignoradas.` : "");
    statusEl.innerHTML = statusMsg;

    if(document.querySelector('nav.menu button.active')?.dataset.page === "entregas") navigate("entregas");

    if(sb){
      statusEl.innerHTML = statusMsg + "<br>Gravando no banco de dados...";
      try{
        await sbSubstituirTabela("entregas_lancamentos", novos.map(r=>({ data:r.d, servico:r.servico, transportadora:r.transportadora, cliente:r.cliente, motorista:r.motorista, carro:r.carro, qnt:r.qnt, valor:r.v, observacao:r.observacao||null })));
        statusEl.innerHTML = statusMsg + "<br>✓ Banco de dados atualizado — todo mundo que abrir o link já vê essa importação.";
        toast(`✓ ${novos.length} operações importadas (salvo no banco)`);
      }catch(e){
        statusEl.innerHTML = statusMsg + avisoFalhaGravacao(e);
        toast("⚠ A importação NÃO foi salva no banco — veja o aviso na tela");
      }
    } else {
      toast(`✓ ${novos.length} operações importadas`);
    }
  }catch(e){
    console.error(e);
    statusEl.textContent = "⚠ Erro ao ler o arquivo: " + e.message;
  }
};

window.importContasPagarXlsx = async () => {
  const fileInput = document.getElementById("ecp-import-file");
  const statusEl = document.getElementById("ecp-import-status");
  const file = fileInput.files[0];
  if(!file){ statusEl.textContent = "⚠ Selecione um arquivo primeiro."; return; }
  if(typeof XLSX === "undefined"){ statusEl.textContent = "⚠ Biblioteca de planilhas não carregada (confira se xlsx.full.min.js está na pasta)."; return; }

  statusEl.textContent = "Lendo planilha...";
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type:"array", cellDates:true });

    // Só a aba "MATRIZ" é importada — mesma convenção usada em Manutenção/Infrações/Entregas.
    const nomeAbaAlvo = wb.SheetNames.find(n=>n.trim().toUpperCase()==="MATRIZ");
    if(!nomeAbaAlvo){
      statusEl.textContent = `⚠ Não encontrei uma aba chamada "MATRIZ" nesta planilha. Abas encontradas: ${wb.SheetNames.join(", ")}.`;
      return;
    }

    const rows = XLSX.utils.sheet_to_json(wb.Sheets[nomeAbaAlvo], { header:1, defval:null });
    let headerRow = null, sheetRows = null;
    for(let i=0;i<Math.min(rows.length,30);i++){
      const r = rows[i];
      if(r && r.some(c=>c!=null && String(c).trim().toUpperCase()==="FORNECEDOR") && r.some(c=>c!=null && String(c).trim().toUpperCase()==="CNPJ")){
        headerRow = r; sheetRows = rows.slice(i+1); break;
      }
    }
    if(!headerRow){
      statusEl.textContent = "⚠ Não encontrei a linha de cabeçalho (esperava colunas 'Fornecedor' e 'CNPJ') na aba MATRIZ. Confira se é a mesma estrutura do seu relatório.";
      return;
    }

    const idx = {};
    headerRow.forEach((h,i)=>{ if(h!=null) idx[String(h).trim().toUpperCase()] = i; });
    const col = (name) => idx[name];
    // "VALOR SO SERVIÇO" é o nome real da coluna na planilha (com esse typo mesmo) — aceita variações
    // pra não quebrar se um dia corrigirem a grafia.
    let cValor = col("VALOR SO SERVIÇO") ?? col("VALOR DO SERVIÇO");
    if(cValor == null){ const k = Object.keys(idx).find(k=>k.startsWith("VALOR")); if(k) cValor = idx[k]; }
    const cFornecedor = col("FORNECEDOR"), cCnpj = col("CNPJ"), cTipo = col("TIPO DO SERVIÇO"), cServico = col("SERVIÇO"),
          cNumOS = col("NO. DA O.S"), cDataOS = col("DATA DA O.S"), cParcela = col("PARCELA"),
          cForma = col("FORMA DE PAGAMENTO"), cVencimento = col("DATA DO VENCIMENTO"), cStatus = col("STATUS DO PAGAMENTO");
    if(cFornecedor==null || cValor==null){
      statusEl.textContent = "⚠ Faltam colunas essenciais (FORNECEDOR ou VALOR) na aba MATRIZ. Confira o cabeçalho da planilha.";
      return;
    }

    const novos = [];
    let ignoradas = 0;
    sheetRows.forEach(r=>{
      if(!r) return;
      const fornecedorRaw = r[cFornecedor], valorRaw = r[cValor];
      if(fornecedorRaw == null || String(fornecedorRaw).trim()==="" || valorRaw == null || valorRaw === ""){ ignoradas++; return; }
      const valor = parseValorBRL(valorRaw);
      if(isNaN(valor)){ ignoradas++; return; }
      // Vencimento pode faltar em alguma linha (raro) — a conta ainda entra nos totais, só fica de
      // fora dos filtros/gráficos por ano e mês e some como "Sem vencimento" na situação.
      const vencimentoIso = cVencimento!=null ? excelDateToISO(r[cVencimento]) : null;
      const emissaoIso = cDataOS!=null ? excelDateToISO(r[cDataOS]) : null;
      const statusRaw = cStatus!=null ? String(r[cStatus]||"").trim() : "";
      novos.push({
        id: localId(),
        prestador: String(fornecedorRaw).trim(),
        cnpj: (cCnpj!=null ? (r[cCnpj]||"").toString().trim() : ""),
        tipoServico: (cTipo!=null && r[cTipo]!=null && String(r[cTipo]).trim()!=="") ? String(r[cTipo]).trim() : "Outros",
        servico: (cServico!=null && r[cServico]!=null && String(r[cServico]).trim()!=="") ? String(r[cServico]).trim() : null,
        numeroDocumento: (cNumOS!=null && r[cNumOS]!=null) ? String(r[cNumOS]).trim() : null,
        dataEmissao: emissaoIso,
        parcela: (cParcela!=null && r[cParcela]!=null && String(r[cParcela]).trim()!=="") ? String(r[cParcela]).trim() : null,
        valor,
        formaPagamento: (cForma!=null ? (r[cForma]||"").toString().trim() : ""),
        dataVencimento: vencimentoIso,
        status: statusRaw || "A Pagar",
        dataPagamento: null
      });
    });

    if(novos.length === 0){
      statusEl.textContent = "⚠ Nenhuma conta válida encontrada na planilha.";
      return;
    }

    const anteriores = DATA.contasPagar.lancamentos;
    DATA.contasPagar.lancamentos = novos;
    logEntry("Contas a Pagar (importação)", `${novos.length} contas importadas de "${file.name}"`, { kind:"bulkImportContasPagar", anteriores });
    renderSessionLog();

    const semVenc = novos.filter(r=>!r.dataVencimento).length;
    let statusMsg = `✓ <b>${fmtNum(novos.length)}</b> contas importadas, total ${fmtBRL(novos.reduce((s,r)=>s+r.valor,0))}.` +
      (semVenc>0 ? `<br>${semVenc} conta(s) sem data de vencimento na planilha (ficam fora dos filtros de ano/mês).` : "") +
      (ignoradas>0 ? `<br>${ignoradas} linha(s) sem fornecedor ou valor válido foram ignoradas.` : "");
    statusEl.innerHTML = statusMsg;

    if(document.querySelector('nav.menu button.active')?.dataset.page === "contaspagar") navigate("contaspagar");

    if(sb){
      statusEl.innerHTML = statusMsg + "<br>Gravando no banco de dados...";
      try{
        await sbSubstituirTabela("contas_pagar", novos.map(r=>({
          prestador:r.prestador, cnpj:r.cnpj, tipo_servico:r.tipoServico, servico:r.servico, numero_documento:r.numeroDocumento,
          data_emissao:r.dataEmissao, parcela:r.parcela, valor:r.valor, forma_pagamento:r.formaPagamento,
          data_vencimento:r.dataVencimento, status:r.status, data_pagamento:r.dataPagamento
        })));
        statusEl.innerHTML = statusMsg + "<br>✓ Banco de dados atualizado — todo mundo que abrir o link já vê essa importação.";
        toast(`✓ ${novos.length} contas importadas (salvo no banco)`);
      }catch(e){
        statusEl.innerHTML = statusMsg + avisoFalhaGravacao(e);
        toast("⚠ A importação NÃO foi salva no banco — veja o aviso na tela");
      }
    } else {
      toast(`✓ ${novos.length} contas importadas`);
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
  const servico = document.getElementById("ecp-servico").value.trim();
  const valor = parseFloat(document.getElementById("ecp-valor").value);
  const parcela = document.getElementById("ecp-parcela").value.trim();
  const forma = document.getElementById("ecp-forma").value;
  const emissao = document.getElementById("ecp-emissao").value;
  const vencimento = document.getElementById("ecp-vencimento").value;
  const numdoc = document.getElementById("ecp-numdoc").value.trim();

  if(!prestador || isNaN(valor) || !vencimento){ toast("Preencha ao menos prestador, valor e vencimento."); return; }

  const novaConta = {
    id: localId(), prestador, cnpj, tipoServico: tipo || "Outros", servico: servico || tipo || "Outros", parcela: parcela || null,
    valor, formaPagamento: forma, dataEmissao: emissao || null, dataVencimento: vencimento, numeroDocumento: numdoc || null,
    status: "Pendente", dataPagamento: null
  };
  DATA.contasPagar.lancamentos.push(novaConta);
  const undoDescr = prepararDesfazerArrayById("contasPagar.lancamentos", novaConta.id, "contas_pagar");
  logEntry("Contas a Pagar", `${prestador} · ${fmtBRL2(valor)} · vence ${vencimento.split("-").reverse().join("/")}`, undoDescr);
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "contaspagar") navigate("contaspagar");

  if(sb){
    const { data, error } = await sb.from("contas_pagar").insert({
      prestador, cnpj, tipo_servico: tipo || "Outros", servico: servico || tipo || "Outros", parcela: parcela || null,
      valor, forma_pagamento: forma, data_emissao: emissao || null, data_vencimento: vencimento,
      numero_documento: numdoc || null, status: "Pendente"
    }).select().single();
    if(error){ toast("⚠ Salvo aqui, mas falhou ao gravar no banco: " + error.message); return; }
    novaConta.id = data.id; // troca o id local pelo id real do banco, pra "marcar como pago" funcionar depois
    undoDescr.itemId = data.id;
    undoDescr.sbId = data.id;
    salvarSessionLogLocal();
  }
  toast("Conta a pagar adicionada ✓" + (sb ? " (salvo no banco)" : ""));
};

window.importFaturamentoXlsx = async () => {
  const fileInput = document.getElementById("eft-import-file");
  const statusEl = document.getElementById("eft-import-status");
  const file = fileInput.files[0];
  if(!file){ statusEl.textContent = "⚠ Selecione um arquivo primeiro."; return; }
  if(typeof XLSX === "undefined"){ statusEl.textContent = "⚠ Biblioteca de planilhas não carregada (confira se xlsx.full.min.js está na pasta)."; return; }

  statusEl.textContent = "Lendo planilha...";
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type:"array", cellDates:true });

    // O nome da aba muda todo ano (ex: "CONTRATOS 2026"), então procura em todas as abas a linha de
    // cabeçalho com as colunas CONTRATO e VENCIMENTO — mesma ideia usada na importação de Folha.
    let headerRow = null, sheetRows = null;
    for(const nomeAba of wb.SheetNames){
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header:1, defval:null });
      for(let i=0;i<Math.min(rows.length,30);i++){
        const r = rows[i];
        if(r && r.some(c=>c!=null && String(c).trim().toUpperCase()==="CONTRATO") && r.some(c=>c!=null && String(c).trim().toUpperCase()==="VENCIMENTO")){
          headerRow = r; sheetRows = rows.slice(i+1); break;
        }
      }
      if(headerRow) break;
    }
    if(!headerRow){
      statusEl.textContent = `⚠ Não encontrei a linha de cabeçalho (esperava colunas 'Contrato' e 'Vencimento') em nenhuma aba. Abas encontradas: ${wb.SheetNames.join(", ")}.`;
      return;
    }

    const idx = {};
    headerRow.forEach((h,i)=>{ if(h!=null) idx[String(h).trim().toUpperCase()] = i; });
    const col = (name) => idx[name];
    const cContrato = col("CONTRATO"), cNf = col("NF"), cDeadline = col("DEADLINE"), cDoc = col("DOC"),
          cBalsa = col("BALSA/VIAGEM"), cValor = col("VALOR"), cVencimento = col("VENCIMENTO");
    if(cValor==null || cVencimento==null){
      statusEl.textContent = "⚠ Faltam colunas essenciais (VALOR ou VENCIMENTO) na planilha. Confira o cabeçalho.";
      return;
    }

    const novos = [];
    let ignoradas = 0;
    sheetRows.forEach(r=>{
      if(!r) return;
      const valorRaw = r[cValor];
      if(valorRaw == null || valorRaw === ""){ ignoradas++; return; }
      const valor = parseValorBRL(valorRaw);
      if(isNaN(valor)){ ignoradas++; return; }
      const docRaw = cDoc!=null ? r[cDoc] : null;
      const docTxt = (docRaw!=null && String(docRaw).trim()!=="" && String(docRaw).trim()!=="-") ? (excelDateToISO(docRaw) || String(docRaw).trim()) : null;
      novos.push({
        id: localId(),
        contrato: (cContrato!=null && r[cContrato]!=null) ? String(r[cContrato]).trim() : null,
        nf: (cNf!=null && r[cNf]!=null && String(r[cNf]).trim()!=="") ? String(r[cNf]).trim() : null,
        deadline: cDeadline!=null ? excelDateToISO(r[cDeadline]) : null,
        doc: docTxt,
        balsaViagem: (cBalsa!=null && r[cBalsa]!=null && String(r[cBalsa]).trim()!=="") ? String(r[cBalsa]).trim() : null,
        valor,
        vencimento: excelDateToISO(r[cVencimento])
      });
    });

    if(novos.length === 0){
      statusEl.textContent = "⚠ Nenhum lançamento válido encontrado na planilha.";
      return;
    }

    const anteriores = DATA.faturamento.lancamentos;
    DATA.faturamento.lancamentos = novos;
    logEntry("Faturamento (importação)", `${novos.length} lançamentos importados de "${file.name}"`, { kind:"bulkImportFaturamento", anteriores });
    renderSessionLog();

    const semVenc = novos.filter(r=>!r.vencimento).length;
    let statusMsg = `✓ <b>${fmtNum(novos.length)}</b> lançamentos importados, total ${fmtBRL(novos.reduce((s,r)=>s+r.valor,0))}.` +
      (semVenc>0 ? `<br>${semVenc} lançamento(s) sem data de vencimento reconhecida na planilha (ficam fora dos filtros/gráficos de ano e mês).` : "") +
      (ignoradas>0 ? `<br>${ignoradas} linha(s) sem valor válido foram ignoradas.` : "");
    statusEl.innerHTML = statusMsg;

    if(document.querySelector('nav.menu button.active')?.dataset.page === "faturamento") navigate("faturamento");

    if(sb){
      statusEl.innerHTML = statusMsg + "<br>Gravando no banco de dados...";
      try{
        await sbSubstituirTabela("faturamento_lancamentos", novos.map(r=>({
          contrato:r.contrato, nf:r.nf, deadline:r.deadline, doc:r.doc, balsa_viagem:r.balsaViagem, valor:r.valor, vencimento:r.vencimento
        })));
        statusEl.innerHTML = statusMsg + "<br>✓ Banco de dados atualizado — todo mundo que abrir o link já vê essa importação.";
        toast(`✓ ${novos.length} lançamentos importados (salvo no banco)`);
      }catch(e){
        statusEl.innerHTML = statusMsg + avisoFalhaGravacao(e);
        toast("⚠ A importação NÃO foi salva no banco — veja o aviso na tela");
      }
    } else {
      toast(`✓ ${novos.length} lançamentos importados`);
    }
  }catch(e){
    console.error(e);
    statusEl.textContent = "⚠ Erro ao ler o arquivo: " + e.message;
  }
};

window.submitFaturamento = async () => {
  const contrato = document.getElementById("eft-contrato").value.trim();
  const nf = document.getElementById("eft-nf").value.trim();
  const balsaViagem = document.getElementById("eft-balsa").value.trim();
  const valor = parseFloat(document.getElementById("eft-valor").value);
  const deadline = document.getElementById("eft-deadline").value;
  const vencimento = document.getElementById("eft-vencimento").value;
  const doc = document.getElementById("eft-doc").value.trim();

  if(isNaN(valor) || !vencimento){ toast("Preencha ao menos valor e vencimento."); return; }

  const novoLancamento = {
    id: localId(), contrato: contrato || null, nf: nf || null, deadline: deadline || null,
    doc: doc || null, balsaViagem: balsaViagem || null, valor, vencimento
  };
  DATA.faturamento.lancamentos.push(novoLancamento);
  const undoDescr = prepararDesfazerArrayById("faturamento.lancamentos", novoLancamento.id, "faturamento_lancamentos");
  logEntry("Faturamento", `${balsaViagem || contrato || "Lançamento"} · ${fmtBRL2(valor)} · vence ${vencimento.split("-").reverse().join("/")}`, undoDescr);
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "faturamento") navigate("faturamento");

  if(sb){
    const { data, error } = await sb.from("faturamento_lancamentos").insert({
      contrato: contrato || null, nf: nf || null, deadline: deadline || null, doc: doc || null,
      balsa_viagem: balsaViagem || null, valor, vencimento
    }).select().single();
    if(error){ toast("⚠ Salvo aqui, mas falhou ao gravar no banco: " + error.message); return; }
    novoLancamento.id = data.id; // troca o id local pelo id real do banco
    undoDescr.itemId = data.id;
    undoDescr.sbId = data.id;
    salvarSessionLogLocal();
  }
  toast("Lançamento de faturamento adicionado ✓" + (sb ? " (salvo no banco)" : ""));
};

window.importAtestadosXlsx = async () => {
  const fileInput = document.getElementById("eat-import-file");
  const statusEl = document.getElementById("eat-import-status");
  const file = fileInput.files[0];
  if(!file){ statusEl.textContent = "⚠ Selecione um arquivo primeiro."; return; }
  if(typeof XLSX === "undefined"){ statusEl.textContent = "⚠ Biblioteca de planilhas não carregada."; return; }

  statusEl.textContent = "Lendo planilha...";
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type:"array", cellDates:true });
    // A aba de lançamentos é a base de tudo; as outras abas da planilha (DASHBOARD, CONTROLE MENSAL,
    // FALTAS POR MOTIVO...) são resumos calculados a partir dela, então são ignoradas de propósito —
    // o painel refaz esses mesmos cálculos por conta própria.
    const preferidas = wb.SheetNames.filter(n=>n.trim().toUpperCase().startsWith("LAN"));
    let headerRow = null, sheetRows = null;
    for(const nome of [...preferidas, ...wb.SheetNames]){
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header:1, defval:null });
      for(let i=0;i<Math.min(rows.length,30);i++){
        const r = rows[i];
        if(r && r.some(c=>c!=null && String(c).trim().toUpperCase()==="COLABORADOR")
             && r.some(c=>c!=null && String(c).trim().toUpperCase()==="DATA")){
          headerRow = r; sheetRows = rows.slice(i+1); break;
        }
      }
      if(headerRow) break;
    }
    if(!headerRow){
      statusEl.textContent = `⚠ Não encontrei em nenhuma aba a linha de cabeçalho com 'DATA' e 'COLABORADOR'. Abas encontradas: ${wb.SheetNames.join(", ")}.`;
      return;
    }

    const idx = {};
    headerRow.forEach((h,i)=>{ if(h!=null) idx[String(h).trim().toUpperCase()] = i; });
    const col = (n) => idx[n];
    const cData = col("DATA"), cColab = col("COLABORADOR"), cMotivo = col("MOTIVO / CID") ?? col("MOTIVO"),
          cHoras = col("HORAS"), cDias = col("DIAS"), cCat = col("CATEGORIA"),
          cRetorno = col("DATA RETORNO"), cObs = col("OBSERVAÇÃO") ?? col("OBSERVACAO");
    if(cData==null){ statusEl.textContent = "⚠ Falta a coluna essencial DATA na aba de lançamentos."; return; }

    const novos = []; let ignoradas = 0;
    sheetRows.forEach(r=>{
      if(!r) return;
      const iso = excelDateToISO(r[cData]);
      if(!iso){ ignoradas++; return; }
      const num = (c) => {
        if(c == null) return null;
        const v = parseValorBRL(r[c]);
        return isNaN(v) ? null : v;
      };
      novos.push({
        id: localId(), d: iso,
        colaborador: cColab!=null ? String(r[cColab]||"").trim() : "",
        motivo: cMotivo!=null ? String(r[cMotivo]||"").trim() : "",
        categoria: cCat!=null ? String(r[cCat]||"").trim() : "",
        horas: num(cHoras),
        dias: num(cDias) || 0,
        dataRetorno: cRetorno!=null ? excelDateToISO(r[cRetorno]) : null,
        observacao: cObs!=null ? String(r[cObs]||"").trim() : ""
      });
    });
    if(!novos.length){ statusEl.textContent = "⚠ Nenhum atestado válido encontrado na planilha."; return; }

    const anteriores = DATA.atestados.lancamentos;
    DATA.atestados.lancamentos = novos;
    logEntry("Atestados (importação)", `${novos.length} ocorrências importadas de "${file.name}"`, { kind:"bulkImportAtestados", anteriores });
    renderSessionLog();

    const datas = novos.map(r=>r.d).sort();
    const totalDias = sumArr(novos.map(r=>r.dias));
    const statusMsg = `✓ <b>${fmtNum(novos.length)}</b> atestados importados (${fmtDataBR(datas[0])} a ${fmtDataBR(datas[datas.length-1])}), ${fmtNum(+totalDias.toFixed(2))} dias perdidos no total.` +
      (ignoradas>0 ? `<br>${ignoradas} linha(s) sem data válida foram ignoradas.` : "");
    statusEl.innerHTML = statusMsg;
    if(document.querySelector('nav.menu button.active')?.dataset.page === "atestados") navigate("atestados");

    if(!sb){ toast(`✓ ${novos.length} atestados importados`); return; }
    statusEl.innerHTML = statusMsg + "<br>Gravando no banco de dados...";
    try{
      await sbSubstituirTabela("atestados_lancamentos", novos.map(r=>({
        data:r.d, colaborador:r.colaborador, motivo:r.motivo, categoria:r.categoria,
        horas:r.horas, dias:r.dias, data_retorno:r.dataRetorno, observacao:r.observacao
      })));
      statusEl.innerHTML = statusMsg + "<br>✓ Banco de dados atualizado — todo mundo que abrir o link já vê essa importação.";
      toast(`✓ ${novos.length} atestados importados (salvo no banco)`);
    }catch(e){
      statusEl.innerHTML = statusMsg + avisoFalhaGravacao(e);
      toast("⚠ A importação NÃO foi salva no banco — veja o aviso na tela");
    }
  }catch(e){ console.error(e); statusEl.textContent = "⚠ Erro ao ler o arquivo: " + e.message; }
};

function heParaBanco(r){
  return { colaborador:r.colaborador, funcao:r.funcao, mes:`${r.mes}-01`, total:r.total,
           he20:r.he20, he50:r.he50, he100:r.he100, dissidio:r.dissidio };
}

window.importHoraExtraXlsx = async () => {
  const fileInput = document.getElementById("ehe-import-file");
  const statusEl = document.getElementById("ehe-import-status");
  const file = fileInput.files[0];
  if(!file){ statusEl.textContent = "⚠ Selecione um arquivo primeiro."; return; }
  if(typeof XLSX === "undefined"){ statusEl.textContent = "⚠ Biblioteca de planilhas não carregada."; return; }

  statusEl.textContent = "Lendo planilha...";
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type:"array", cellDates:true });
    // Procura a aba com cabeçalho COLABORADOR (a planilha escreve "COLOBORADOR") + MÊS + TOTAL,
    // começando pelas que se chamam "DADOS..." — as demais abas (CADASTRO, CONTROLE FOLHA) são ignoradas.
    const ehColab = (c) => c!=null && /^COL[OA]BORADOR$/.test(String(c).trim().toUpperCase());
    const preferidas = wb.SheetNames.filter(n=>n.trim().toUpperCase().startsWith("DADOS"));
    let headerRow = null, sheetRows = null;
    for(const nome of [...preferidas, ...wb.SheetNames]){
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header:1, defval:null });
      for(let i=0;i<Math.min(rows.length,30);i++){
        const r = rows[i];
        if(r && r.some(ehColab) && r.some(c=>c!=null && String(c).trim().toUpperCase()==="TOTAL")){ headerRow = r; sheetRows = rows.slice(i+1); break; }
      }
      if(headerRow) break;
    }
    if(!headerRow){ statusEl.textContent = `⚠ Não encontrei a linha de cabeçalho com 'COLABORADOR' e 'TOTAL'. Abas: ${wb.SheetNames.join(", ")}.`; return; }

    const idx = {};
    headerRow.forEach((h,i)=>{ if(h!=null) idx[String(h).trim().toUpperCase().replace(/\s+/g," ")] = i; });
    const cColab = headerRow.findIndex(ehColab), cMes = idx["MÊS"] ?? idx["MES"], cFuncao = idx["FUNÇÃO"] ?? idx["FUNCAO"],
          c20 = idx["H.E 20%"], c50 = idx["H.E 50%"], c100 = idx["H.E 100%"],
          cDm = idx["DISSIDIO MAIO"] ?? idx["DISSÍDIO MAIO"], cD50 = idx["DISSIDIO 50%"] ?? idx["DISSÍDIO 50%"],
          cTotal = idx["TOTAL"], cAno = idx["ANO"];
    if(cMes==null){ statusEl.textContent = "⚠ Falta a coluna MÊS na planilha."; return; }

    const num = (r,c) => { if(c==null || r[c]==null || r[c]==="") return 0; const v = typeof r[c]==="number" ? r[c] : parseValorBRL(r[c]); return isNaN(v) ? 0 : Math.round(v*100)/100; };
    const novos = []; let ignoradas = 0;
    sheetRows.forEach(r=>{
      if(!r || !r[cColab] || ehColab(r[cColab])) return;          // linha vazia ou cabeçalho repetido
      let mesNum = null, anoData = null;
      const d = r[cMes];
      if(d instanceof Date && !isNaN(d)){ const dd = new Date(d.getTime() + 12*3600*1000); mesNum = dd.getMonth()+1; anoData = dd.getFullYear(); }
      else { const iso = excelDateToISO(d); if(iso){ mesNum = Number(iso.slice(5,7)); anoData = Number(iso.slice(0,4)); } }
      const ano = (cAno!=null && Number(r[cAno])>2000) ? Number(r[cAno]) : anoData;
      if(!mesNum || !ano){ ignoradas++; return; }
      const he20 = num(r,c20), he50 = num(r,c50), he100 = num(r,c100), dissidio = Math.round((num(r,cDm)+num(r,cD50))*100)/100;
      const total = (cTotal!=null && r[cTotal]!=null && r[cTotal]!=="") ? num(r,cTotal) : Math.round((he20+he50+he100+dissidio)*100)/100;
      novos.push({ id:localId(), colaborador:String(r[cColab]).trim().toUpperCase(), funcao:cFuncao!=null ? String(r[cFuncao]||"").trim().toUpperCase() : "",
        mes:`${ano}-${String(mesNum).padStart(2,"0")}`, total, he20, he50, he100, dissidio });
    });
    if(!novos.length){ statusEl.textContent = "⚠ Nenhum lançamento válido encontrado na planilha."; return; }

    const anteriores = DATA.horaExtra.lancamentos;
    DATA.horaExtra.lancamentos = novos;
    deriveHoraExtra();
    logEntry("Hora Extra (importação)", `${novos.length} lançamentos importados de "${file.name}"`, { kind:"bulkImportHoraExtra", anteriores });
    renderSessionLog();

    const meses = novos.map(r=>r.mes).sort();
    const nomeMes = (m) => `${MESES_HE[Number(m.slice(5))-1]}/${m.slice(2,4)}`;
    const porAno = {}; novos.forEach(r=>{ const a = r.mes.slice(0,4); porAno[a] = (porAno[a]||0) + r.total; });
    const statusMsg = `✓ <b>${fmtNum(novos.length)}</b> lançamentos importados (${nomeMes(meses[0])} a ${nomeMes(meses[meses.length-1])}) — ` +
      Object.entries(porAno).map(([a,v])=>`${a}: <b>${fmtBRL(v)}</b>`).join(" · ") +
      (ignoradas>0 ? `<br>${ignoradas} linha(s) sem mês válido foram ignoradas.` : "");
    statusEl.innerHTML = statusMsg;
    if(document.querySelector('nav.menu button.active')?.dataset.page === "horaextra") navigate("horaextra");

    if(!sb){ toast(`✓ ${novos.length} lançamentos de hora extra importados`); return; }
    statusEl.innerHTML = statusMsg + "<br>Gravando no banco de dados...";
    try{
      await sbSubstituirTabela("horaextra_lancamentos", novos.map(heParaBanco));
      statusEl.innerHTML = statusMsg + "<br>✓ Banco de dados atualizado — todo mundo que abrir o link já vê essa importação.";
      toast(`✓ ${novos.length} lançamentos de hora extra importados (salvo no banco)`);
    }catch(e){
      statusEl.innerHTML = statusMsg + avisoFalhaGravacao(e);
      toast("⚠ A importação NÃO foi salva no banco — veja o aviso na tela");
    }
  }catch(e){ console.error(e); statusEl.textContent = "⚠ Erro ao ler o arquivo: " + e.message; }
};

/* -------------------- IMPORTAÇÕES DA OPERAÇÃO BELÉM --------------------
   As três planilhas de Belém têm os mesmos formatos das equivalentes de Manaus (abastecimento de
   diesel, pagamento de salários e compras de peças), então cada leitor abaixo reaproveita o mesmo
   layout de colunas do módulo correspondente — só que convertendo tudo pro formato único de
   belem_lancamentos (data, categoria, descrição, referência, quantidade, valor).
   Importar uma categoria substitui apenas os lançamentos daquela categoria; as outras duas ficam
   intactas, porque cada uma vem de uma planilha diferente e é atualizada em momentos diferentes. */

// Substitui no banco só os lançamentos de UMA categoria de Belém, preservando as outras duas.
// Mesma ordem segura do sbSubstituirTabela: grava o novo primeiro, apaga o antigo depois.
async function substituirCategoriaBelem(categoria, linhas){
  const { data: antigos, error: errBusca } = await sb.from("belem_lancamentos").select("id").eq("categoria", categoria);
  if(errBusca) throw errBusca;
  await sbBulkInsert("belem_lancamentos", linhas);
  const ids = (antigos||[]).map(r=>r.id);
  for(let i=0;i<ids.length;i+=200){
    const { error } = await sb.from("belem_lancamentos").delete().in("id", ids.slice(i, i+200));
    if(error) throw error;
  }
}

// Caminho comum das 3 importações: troca a categoria no DATA local, redesenha, e grava no banco.
async function finalizarImportBelem(categoria, novos, statusEl, statusMsg, file){
  const anteriores = DATA.belem.lancamentos;
  DATA.belem.lancamentos = anteriores.filter(r=>r.categoria !== categoria).concat(novos);
  const nomeCat = BELEM_CATEGORIAS.find(c=>c.chave===categoria).label;
  logEntry(`Belém · ${nomeCat} (importação)`, `${novos.length} lançamentos de "${file.name}"`, { kind:"bulkImportBelem", categoria, anteriores });
  renderSessionLog();
  statusEl.innerHTML = statusMsg;
  if(document.querySelector('nav.menu button.active')?.dataset.page === "belem") navigate("belem");

  if(!sb){ toast(`✓ ${novos.length} lançamentos importados`); return; }
  statusEl.innerHTML = statusMsg + "<br>Gravando no banco de dados...";
  try{
    await substituirCategoriaBelem(categoria, novos.map(r=>({
      data:r.d, categoria:r.categoria, descricao:r.descricao, referencia:r.referencia, quantidade:r.qtd, valor:r.v
    })));
    statusEl.innerHTML = statusMsg + "<br>✓ Banco de dados atualizado — todo mundo que abrir o link já vê essa importação.";
    toast(`✓ ${novos.length} lançamentos de ${nomeCat} importados (salvo no banco)`);
  }catch(e){
    statusEl.innerHTML = statusMsg + avisoFalhaGravacao(e);
    toast("⚠ A importação NÃO foi salva no banco — veja o aviso na tela");
  }
}

window.importBelemCombustivelXlsx = async () => {
  const fileInput = document.getElementById("eb-comb-file");
  const statusEl = document.getElementById("eb-comb-status");
  const file = fileInput.files[0];
  if(!file){ statusEl.textContent = "⚠ Selecione um arquivo primeiro."; return; }
  if(typeof XLSX === "undefined"){ statusEl.textContent = "⚠ Biblioteca de planilhas não carregada."; return; }

  statusEl.textContent = "Lendo planilha...";
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type:"array", cellDates:true });
    // O nome da aba muda de uma planilha pra outra ("Abastecimento" em Manaus, "Dados" em Belém),
    // então tenta os nomes conhecidos primeiro e, se não achar, procura em qualquer aba a linha de
    // cabeçalho que tenha a coluna PLACA — o layout das colunas é o mesmo nas duas.
    const preferidas = wb.SheetNames.filter(n=>["ABASTECIMENTO","DADOS"].includes(n.trim().toUpperCase()));
    let headerRow = null, sheetRows = null;
    for(const nome of [...preferidas, ...wb.SheetNames]){
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header:1, defval:null });
      for(let i=0;i<Math.min(rows.length,30);i++){
        const r = rows[i];
        if(r && r.some(c=>c!=null && String(c).trim().toUpperCase()==="PLACA")
             && r.some(c=>c!=null && String(c).trim().toUpperCase()==="DATA")){
          headerRow = r; sheetRows = rows.slice(i+1); break;
        }
      }
      if(headerRow) break;
    }
    if(!headerRow){ statusEl.textContent = `⚠ Não encontrei em nenhuma aba a linha de cabeçalho com as colunas 'DATA' e 'PLACA'. Abas encontradas: ${wb.SheetNames.join(", ")}.`; return; }

    const idx = {};
    headerRow.forEach((h,i)=>{ if(h!=null) idx[String(h).trim().toUpperCase()] = i; });
    const col = (n) => idx[n];
    const cData = col("DATA"), cPlaca = col("PLACA"), cLitros = col("LITROS"),
          cValor = col("VALOR POR VEÍCULO") ?? col("VALOR"), cPosto = col("POSTO");
    if(cData==null || cValor==null){ statusEl.textContent = "⚠ Faltam colunas essenciais (DATA ou VALOR POR VEÍCULO) na aba Abastecimento."; return; }

    const novos = []; let ignoradas = 0;
    sheetRows.forEach(r=>{
      if(!r) return;
      const iso = excelDateToISO(r[cData]);
      const valor = parseValorBRL(r[cValor]);
      if(!iso || isNaN(valor)){ ignoradas++; return; }
      novos.push({ id:localId(), d:iso, categoria:"combustivel",
        descricao: cPosto!=null ? String(r[cPosto]||"").trim() : "",
        referencia: cPlaca!=null ? String(r[cPlaca]||"").trim() : "",
        qtd: cLitros!=null ? (parseValorBRL(r[cLitros])||null) : null, v:valor });
    });
    if(!novos.length){ statusEl.textContent = "⚠ Nenhum abastecimento válido encontrado na planilha."; return; }

    const datas = novos.map(r=>r.d).sort();
    const statusMsg = `✓ <b>${fmtNum(novos.length)}</b> abastecimentos importados (${fmtDataBR(datas[0])} a ${fmtDataBR(datas[datas.length-1])}), total ${fmtBRL(sumArr(novos.map(r=>r.v)))}.` +
      (ignoradas>0 ? `<br>${ignoradas} linha(s) sem data ou valor válido foram ignoradas.` : "");
    await finalizarImportBelem("combustivel", novos, statusEl, statusMsg, file);
  }catch(e){ console.error(e); statusEl.textContent = "⚠ Erro ao ler o arquivo: " + e.message; }
};

window.importBelemMaoObraXlsx = async () => {
  const fileInput = document.getElementById("eb-mo-file");
  const statusEl = document.getElementById("eb-mo-status");
  const file = fileInput.files[0];
  if(!file){ statusEl.textContent = "⚠ Selecione um arquivo primeiro."; return; }
  if(typeof XLSX === "undefined"){ statusEl.textContent = "⚠ Biblioteca de planilhas não carregada."; return; }

  statusEl.textContent = "Lendo planilha...";
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type:"array", cellDates:true });
    // Aqui o nome da aba varia, então procura em todas a linha de cabeçalho que tenha a coluna "Mês".
    let headerRow = null, sheetRows = null;
    for(const nome of wb.SheetNames){
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header:1, defval:null });
      for(let i=0;i<Math.min(rows.length,30);i++){
        const r = rows[i];
        if(r && r.some(c=>c!=null && ["MÊS","MES"].includes(String(c).trim().toUpperCase()))){ headerRow = r; sheetRows = rows.slice(i+1); break; }
      }
      if(headerRow) break;
    }
    if(!headerRow){ statusEl.textContent = "⚠ Não encontrei a linha de cabeçalho (esperava uma coluna 'Mês') em nenhuma aba."; return; }

    const idx = {};
    headerRow.forEach((h,i)=>{ if(h!=null) idx[String(h).trim().toUpperCase()] = i; });
    const col = (n) => idx[n];
    const cMes = col("MÊS") ?? col("MES");
    // Dois formatos de planilha são aceitos, porque as praças controlam a folha de jeitos diferentes:
    //  (a) por colaborador  — uma linha por pessoa/mês, com NOME e TOTAL (formato usado em Belém).
    //      Usa a coluna TOTAL, que já inclui ticket/transporte/salário, pra nada ficar de fora.
    //  (b) por componente   — uma linha por mês, com VT + VR / AD. 40% / Salário (formato de Manaus).
    const cNome = col("NOME"), cTotal = col("TOTAL"), cFuncao = col("FUNÇÃO") ?? col("FUNCAO");
    const porColaborador = cNome != null && cTotal != null;
    const componentes = [
      { label:"VT + VR",       c: col("VT + VR") ?? col("VT+VR") },
      { label:"Adicional 40%", c: col("AD. 40%") ?? col("AD.40%") ?? col("AD 40%") },
      { label:"Salário",       c: col("SALÁRIO") ?? col("SALARIO") }
    ].filter(x=>x.c != null);
    if(cMes==null || (!porColaborador && !componentes.length)){
      statusEl.textContent = "⚠ Faltam colunas essenciais: precisa de 'Mês' mais (NOME + TOTAL) ou pelo menos uma de VT + VR / AD. 40% / Salário.";
      return;
    }

    const novos = []; let ignoradas = 0;
    sheetRows.forEach(r=>{
      if(!r) return;
      const ref = parseMesFolha(r[cMes]);
      if(!ref){ ignoradas++; return; }
      const iso = `${ref.ano}-${String(ref.mes).padStart(2,"0")}-01`;
      if(porColaborador){
        const valor = parseValorBRL(r[cTotal]);
        if(isNaN(valor) || valor === 0){ ignoradas++; return; }
        const nome = String(r[cNome]||"").trim();
        const funcao = cFuncao!=null ? String(r[cFuncao]||"").trim() : "";
        novos.push({ id:localId(), d:iso, categoria:"mao_de_obra",
          descricao: funcao || "Salário", referencia: nome || "Folha", qtd:null, v:valor });
      } else {
        componentes.forEach(comp=>{
          const valor = parseValorBRL(r[comp.c]);
          if(isNaN(valor) || valor === 0) return;
          novos.push({ id:localId(), d:iso, categoria:"mao_de_obra", descricao:comp.label, referencia:"Folha", qtd:null, v:valor });
        });
      }
    });
    if(!novos.length){ statusEl.textContent = "⚠ Nenhum valor de mão de obra válido encontrado na planilha."; return; }

    const meses = [...new Set(novos.map(r=>r.d.slice(0,7)))].sort();
    const statusMsg = `✓ <b>${fmtNum(novos.length)}</b> valores importados, cobrindo ${meses.length} ${meses.length===1?"mês":"meses"} (${rotuloMesBelem(meses[0])} a ${rotuloMesBelem(meses[meses.length-1])}), total ${fmtBRL(sumArr(novos.map(r=>r.v)))}.` +
      (ignoradas>0 ? `<br>${ignoradas} linha(s) sem mês reconhecido foram ignoradas.` : "");
    await finalizarImportBelem("mao_de_obra", novos, statusEl, statusMsg, file);
  }catch(e){ console.error(e); statusEl.textContent = "⚠ Erro ao ler o arquivo: " + e.message; }
};

window.importBelemPecasXlsx = async () => {
  const fileInput = document.getElementById("eb-pecas-file");
  const statusEl = document.getElementById("eb-pecas-status");
  const file = fileInput.files[0];
  if(!file){ statusEl.textContent = "⚠ Selecione um arquivo primeiro."; return; }
  if(typeof XLSX === "undefined"){ statusEl.textContent = "⚠ Biblioteca de planilhas não carregada."; return; }

  statusEl.textContent = "Lendo planilha...";
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type:"array", cellDates:true });
    let headerRow = null, sheetRows = null;
    const nomeAbaTabela = wb.SheetNames.find(n=>n.trim().toUpperCase()==="TABELA");
    for(const name of (nomeAbaTabela ? [nomeAbaTabela] : wb.SheetNames)){
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header:1, defval:null });
      for(let i=0;i<Math.min(rows.length,15);i++){
        const r = rows[i];
        if(r && r[0] && String(r[0]).trim().toUpperCase().indexOf("CAMINH") === 0){ headerRow = r; sheetRows = rows.slice(i+1); break; }
      }
      if(headerRow) break;
    }
    if(!headerRow){ statusEl.textContent = "⚠ Não encontrei a linha de cabeçalho (esperava uma coluna 'CAMINHÃO') na aba Tabela."; return; }

    const idx = {};
    headerRow.forEach((h,i)=>{ if(h!=null) idx[String(h).trim().toUpperCase()] = i; });
    const col = (n) => idx[n];
    const cData = col("DATA DA COMPRA"), cCam = col("CAMINHÃO"), cPeca = col("PEÇA COMPRADAS"),
          cQtde = col("QTDE"), cTotal = col("TOTAL");
    if(cData==null || cTotal==null){ statusEl.textContent = "⚠ Faltam colunas essenciais (DATA DA COMPRA ou TOTAL)."; return; }

    const novos = []; let ignoradas = 0;
    sheetRows.forEach(r=>{
      if(!r) return;
      const iso = excelDateToISO(r[cData]);
      const valor = parseValorBRL(r[cTotal]);
      if(!iso || isNaN(valor)){ ignoradas++; return; }
      novos.push({ id:localId(), d:iso, categoria:"pecas",
        descricao: cPeca!=null ? String(r[cPeca]||"").trim() : "",
        referencia: cCam!=null ? String(r[cCam]||"").trim() : "",
        qtd: cQtde!=null ? (parseValorBRL(r[cQtde])||null) : null, v:valor });
    });
    if(!novos.length){ statusEl.textContent = "⚠ Nenhuma compra válida encontrada na planilha."; return; }

    const datas = novos.map(r=>r.d).sort();
    const statusMsg = `✓ <b>${fmtNum(novos.length)}</b> compras importadas (${fmtDataBR(datas[0])} a ${fmtDataBR(datas[datas.length-1])}), total ${fmtBRL(sumArr(novos.map(r=>r.v)))}.` +
      (ignoradas>0 ? `<br>${ignoradas} linha(s) sem data ou valor válido foram ignoradas.` : "");
    await finalizarImportBelem("pecas", novos, statusEl, statusMsg, file);
  }catch(e){ console.error(e); statusEl.textContent = "⚠ Erro ao ler o arquivo: " + e.message; }
};

window.submitCompra = async () => {
  const d = document.getElementById("ec-data").value;
  const v = parseFloat(document.getElementById("ec-valor").value);
  if(!d || isNaN(v)){ toast("Preencha data e valor."); return; }
  const placa = normalizarPlaca(document.getElementById("ec-placa").value);
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
  const d = document.getElementById("ed-data").value;
  const litros = parseFloat(document.getElementById("ed-litros").value);
  const valorUnit = parseFloat(document.getElementById("ed-valorunit").value);
  if(!d || isNaN(litros) || isNaN(valorUnit)){ toast("Preencha data, litros e valor unitário."); return; }
  const placa = document.getElementById("ed-placa").value.trim();
  const v = +(litros * valorUnit).toFixed(2);
  const registro = { id: localId(), d, placa, km:null, litros, valorUnit, motorista:"", posto:"", status:"", v };
  DATA.diesel.lancamentos.push(registro);
  deriveDiesel();
  const undoDescr = prepararDesfazerArrayById("diesel.lancamentos", registro.id, "diesel_abastecimentos");
  logEntry("Diesel", `${d.split("-").reverse().join("/")} · ${placa || "sem placa"} · ${litros}L · ${fmtBRL2(v)}`, undoDescr);
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "diesel") navigate("diesel");

  if(sb){
    const { data, error } = await sb.from("diesel_abastecimentos").insert({ data:d, placa, litros, valor_unitario:valorUnit, valor:v }).select().single();
    if(error){ toast("⚠ Salvo aqui, mas falhou ao gravar no banco: " + error.message); return; }
    registro.id = data.id;
    undoDescr.itemId = data.id;
    undoDescr.sbId = data.id;
    salvarSessionLogLocal();
  }
  toast("Abastecimento adicionado ✓" + (sb ? " (salvo no banco)" : ""));
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

window.submitEntrega = async () => {
  const d = document.getElementById("eg-data").value;
  const v = parseFloat(document.getElementById("eg-valor").value);
  if(!d || isNaN(v)){ toast("Preencha data e valor."); return; }
  const servico = document.getElementById("eg-servico").value;
  const transportadora = document.getElementById("eg-transportadora").value.trim();
  const cliente = document.getElementById("eg-cliente").value.trim();
  const motorista = document.getElementById("eg-motorista").value.trim();
  const carro = document.getElementById("eg-carro").value.trim();
  const qnt = parseInt(document.getElementById("eg-qnt").value) || 1;
  const observacao = document.getElementById("eg-obs").value.trim();
  const registro = { id: localId(), d, servico, transportadora, cliente, motorista, carro, qnt, v, observacao };
  DATA.entregas.lancamentos.push(registro);
  deriveEntregas();
  const undoDescr = prepararDesfazerArrayById("entregas.lancamentos", registro.id, "entregas_lancamentos");
  logEntry("Entregas", `${d.split("-").reverse().join("/")} · ${servico} · ${cliente || "sem cliente"} · ${fmtBRL2(v)}`, undoDescr);
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "entregas") navigate("entregas");

  if(sb){
    const { data, error } = await sb.from("entregas_lancamentos").insert({ data:d, servico, transportadora, cliente, motorista, carro, qnt, valor:v, observacao: observacao||null }).select().single();
    if(error){ toast("⚠ Salvo aqui, mas falhou ao gravar no banco: " + error.message); return; }
    registro.id = data.id;
    undoDescr.itemId = data.id;
    undoDescr.sbId = data.id;
    salvarSessionLogLocal();
  }
  toast("Operação adicionada ✓" + (sb ? " (salvo no banco)" : ""));
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
  logEntry("Folha", `${label} · total salário ${fmtBRL2(ad+sal)}`, undo);
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "folha") navigate("folha");
  await gravarSeriesPeriodo([
    { modulo:"folha", campo:"vtVr", label, valor:vt },
    { modulo:"folha", campo:"ad40", label, valor:ad },
    { modulo:"folha", campo:"salario", label, valor:sal }
  ], "Folha");
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
  const d = document.getElementById("ei-data").value;
  if(!d){ toast("Preencha a data."); return; }
  const hora = document.getElementById("ei-hora").value || "";
  const motorista = document.getElementById("ei-motorista").value.trim();
  const placa = document.getElementById("ei-placa").value.trim();
  const turno = document.getElementById("ei-turno").value;
  const ocorrencia = document.getElementById("ei-ocorrencia").value.trim();
  const observacoes = document.getElementById("ei-obs").value.trim();
  if(!motorista || !ocorrencia){ toast("Preencha ao menos motorista e ocorrência."); return; }
  const registro = { id: localId(), d, motorista, placa, turno, hora, ocorrencia, observacoes };
  DATA.infracoes.lancamentos.push(registro);
  deriveInfracoes();
  const undoDescr = prepararDesfazerArrayById("infracoes.lancamentos", registro.id, "infracoes_lancamentos");
  logEntry("Infrações", `${d.split("-").reverse().join("/")} · ${motorista} · ${ocorrencia}`, undoDescr);
  renderSessionLog();
  if(document.querySelector('nav.menu button.active')?.dataset.page === "infracoes") navigate("infracoes");

  if(sb){
    const { data, error } = await sb.from("infracoes_lancamentos").insert({ data:d, motorista, placa, turno, hora: hora||null, ocorrencia, observacoes: observacoes||null }).select().single();
    if(error){ toast("⚠ Salvo aqui, mas falhou ao gravar no banco: " + error.message); return; }
    registro.id = data.id;
    undoDescr.itemId = data.id;
    undoDescr.sbId = data.id;
    salvarSessionLogLocal();
  }
  toast("Ocorrência adicionada ✓" + (sb ? " (salvo no banco)" : ""));
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
  mountEntryForm(entryModulesVisiveis()[0].key);
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
  } else if(SUPABASE_FALHA_CONEXAO){
    // Não confundir com "banco vazio" — os dados provavelmente estão lá, só não deu pra buscar agora
    // (caso mais comum: projeto do Supabase pausado por inatividade no plano gratuito). Reimportar uma
    // planilha aqui não resolve nada; é preciso reconectar o banco primeiro.
    el.innerHTML = `<span class="dot" style="background:var(--red);"></span> Falha ao conectar no banco — dados podem estar desatualizados, tente recarregar a página`;
  } else if(SUPABASE_SINCRONIZADO){
    el.innerHTML = `<span class="dot"></span> Conectado ao banco`;
  } else {
    el.innerHTML = `<span class="dot" style="background:var(--amber);"></span> Banco vazio — vá em Entrada de Dados para migrar`;
  }
}

// Perfil Coordenação: carrega só a tabela do faturamento (a Emissão de NF), nada mais do painel
async function carregarFaturamentoDoBanco(){
  const ftLanc = await sbFetchAll("faturamento_lancamentos");
  DATA.faturamento.lancamentos = ftLanc.map(r=>({
    id:r.id, contrato:r.contrato||null, nf:r.nf||null, deadline:r.deadline||null, doc:r.doc||null,
    balsaViagem:r.balsa_viagem||null, valor:Number(r.valor), vencimento:r.vencimento||null
  }));
}

async function iniciarPainel(){
  deriveCompras(); // garante que os dados locais (data.js) já estão prontos como base/fallback
  deriveManutencao();
  deriveDiesel();
  deriveInfracoes();
  deriveEntregas();
  recomputeFolha();
  carregarSessionLogLocal();
  if(MEU_PAPEL === "coordenacao") await carregarFaturamentoDoBanco(); // só os dados da Emissão de NF
  if(PAGINAS_RESTRITAS[MEU_PAPEL]){ navigate(PAGINAS_RESTRITAS[MEU_PAPEL][0]); return; } // perfis restritos não carregam nenhum outro dado do sistema
  navigate("overview"); // mostra algo na tela já, com os dados locais/baseline, sem esperar o Supabase
  // loadFromSupabase() é assíncrono e pode demorar (rede lenta no celular, por exemplo). Nesse meio
  // tempo o usuário pode já ter navegado pra outra página, importado uma planilha etc. — navegar de
  // volta pra "overview" incondicionalmente aqui apagaria (visualmente) o que ele estava vendo/fazendo.
  // Em vez disso, só re-renderiza a página em que ele estiver quando o carregamento terminar (pra
  // refletir os dados reais do banco), e pula esse re-render se for "entrada" pra não resetar um
  // formulário ou seleção de arquivo em andamento.
  const carregouDoBanco = await loadFromSupabase();
  SUPABASE_SINCRONIZADO = carregouDoBanco;
  updateSyncPill();
  const activePage = document.querySelector('nav.menu button.active')?.dataset.page || "overview";
  if(activePage !== "entrada") navigate(activePage);
}

/* ============================================================================
   LOGIN / CADASTRO — trava o painel inteiro (sidebar + conteúdo, escondidos via CSS
   "body:not(.authed)") atrás de e-mail+senha usando a autenticação nativa do Supabase.
   Sem SUPABASE_URL configurado (sb === null) não tem como autenticar, então libera o painel
   direto — mesma filosofia "degrada pra modo local" usada no resto do arquivo.
   ============================================================================ */
let AUTH_MODE = "login"; // ou "signup"
let painelIniciado = false;
let MEU_PAPEL = null; // "diretor" | "operacional" | "lider" | null (ainda sem perfil atribuído)
let MEU_EMAIL = "";

function traduzErroAuth(msg){
  const m = (msg||"").toLowerCase();
  if(m.includes("invalid login credentials")) return "E-mail ou senha incorretos.";
  if(m.includes("already registered") || m.includes("already exists")) return "Já existe uma conta com esse e-mail — tente entrar.";
  if(m.includes("password should be at least") || m.includes("password is too short")) return "A senha precisa ter pelo menos 6 caracteres.";
  if(m.includes("email not confirmed")) return "Confirme seu e-mail antes de entrar (verifique sua caixa de entrada, inclusive o spam).";
  if(m.includes("email") && m.includes("invalid")) return "E-mail inválido.";
  if(m.includes("rate limit")) return "Muitas tentativas seguidas — espere um minuto e tente de novo.";
  if(m.includes("network") || m.includes("fetch")) return "Falha de conexão — confira sua internet e tente de novo.";
  return msg || "Erro ao processar. Tente novamente.";
}

window.toggleAuthMode = () => {
  AUTH_MODE = AUTH_MODE === "login" ? "signup" : "login";
  document.getElementById("authTitle").textContent = AUTH_MODE === "login" ? "Entrar" : "Criar conta";
  document.getElementById("authSubmitBtn").textContent = AUTH_MODE === "login" ? "Entrar" : "Criar conta";
  document.getElementById("authToggleText").textContent = AUTH_MODE === "login" ? "Não tem conta?" : "Já tem conta?";
  document.getElementById("authToggleLink").textContent = AUTH_MODE === "login" ? "Criar conta" : "Entrar";
  document.getElementById("authError").style.display = "none";
  document.getElementById("authMsg").style.display = "none";
};

window.submitAuth = async () => {
  const email = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value;
  const errEl = document.getElementById("authError"), msgEl = document.getElementById("authMsg"), btn = document.getElementById("authSubmitBtn");
  errEl.style.display = "none"; msgEl.style.display = "none";
  if(!sb){ errEl.textContent = "Sem conexão com o banco — não é possível fazer login agora."; errEl.style.display = "block"; return; }
  if(!email || !password){ errEl.textContent = "Preencha e-mail e senha."; errEl.style.display = "block"; return; }

  btn.disabled = true; btn.textContent = AUTH_MODE === "login" ? "Entrando..." : "Criando conta...";
  try{
    if(AUTH_MODE === "login"){
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if(error) throw error;
      // sucesso: o listener sb.auth.onAuthStateChange (registrado no boot) cuida de mostrar o painel
    } else {
      const { data, error } = await sb.auth.signUp({ email, password });
      if(error) throw error;
      if(data.user && !data.session){
        msgEl.textContent = "Conta criada! Verifique seu e-mail e clique no link de confirmação pra poder entrar.";
        msgEl.style.display = "block";
      }
      // se data.session já vier preenchida (confirmação de e-mail desligada no projeto Supabase), o
      // listener abaixo já libera o painel direto, sem precisar de mais nada aqui.
    }
  }catch(e){
    errEl.textContent = traduzErroAuth(e.message);
    errEl.style.display = "block";
  }finally{
    btn.disabled = false;
    btn.textContent = AUTH_MODE === "login" ? "Entrar" : "Criar conta";
  }
};

window.logout = async () => {
  if(sb) await sb.auth.signOut();
  location.reload(); // reseta todo o estado em memória (DATA, filtros, log da sessão) de uma vez
};

// Aplica/remove a visibilidade dos itens do menu marcados com data-requer="diretor" (grupo
// Financeiro + Gestão de Acessos) de acordo com o perfil da pessoa logada.
function aplicarRestricoesDePapel(){
  const souDiretor = MEU_PAPEL === "diretor";
  document.querySelectorAll('[data-requer="diretor"]').forEach(el=>{
    el.style.display = souDiretor ? "" : "none";
  });
  // Líder: o menu mostra só o Status da Frota; some também o botão de exportar dados do topo
  const restritas = PAGINAS_RESTRITAS[MEU_PAPEL];
  const souLider = !!restritas;
  document.querySelectorAll("nav.menu button[data-page], nav.menu .grp-label").forEach(el=>{
    if(souLider) el.style.display = (el.dataset.page && restritas.includes(el.dataset.page)) ? "" : "none";
  });
  document.querySelectorAll('button[onclick="exportDataJs()"]').forEach(el=>{ el.style.display = souLider ? "none" : ""; });
  document.body.classList.toggle("papel-lider", souLider);
}

/* -------------------- ORDENS DE SERVIÇO (PROTÓTIPO) --------------------
   Fluxo: Solicitação → Orçamentos (mín. 2) → Aprovação do diretor → Execução (+ aditivos aprovados)
   → Boleto (conferido contra o valor aprovado) → Pagamento.
   Protótipo para avaliação: dados ficam só no localStorage deste navegador e o seletor "Ver como"
   simula o que cada perfil pode fazer. Depois de aprovado, migra para tabelas no Supabase com RLS. */
const OS_STORAGE_KEY = "avance_os_prototipo_v2";
const OS_PREST_KEY = "avance_os_prestadores_v1";
const OS_PERFIS = {
  manutencao:    { label:"Manutenção",    acoes:["abrir","orcar","enviar","executar","aditivo"] },
  administracao: { label:"Administração", acoes:["boleto","pagar"] },
  gestao:        { label:"Gestão",        acoes:[] },
  diretoria:     { label:"Diretoria",     acoes:["abrir","orcar","enviar","executar","aditivo","aprovar","boleto","pagar","excluir"] },
};
const OS_STATUS = {
  orcamento:   { label:"Aguardando orçamentos",  cor:"gray"  },
  aprovacao:   { label:"Aguardando aprovação",   cor:"amber" },
  execucao:    { label:"Em execução",            cor:"amber" },
  faturamento: { label:"Aguardando boleto",      cor:"gray"  },
  pagamento:   { label:"Aguardando pagamento",   cor:"amber" },
  paga:        { label:"Paga / encerrada",       cor:"green" },
  reprovada:   { label:"Reprovada",              cor:"red"   },
};
const OS_COLUNAS = ["orcamento","aprovacao","execucao","faturamento","pagamento","paga"];
const OS_ETAPAS = [["orcamento","Solicitação / Orçamentos"],["aprovacao","Aprovação"],["execucao","Execução"],["faturamento","Boleto"],["pagamento","Pagamento"],["paga","Encerrada"]];

let OS_PERFIL = "diretoria";
let OS_SEL = null; // id da OS aberta no detalhe (null = quadro)
let OS_LISTA = null;

function osEsc(s){ return String(s ?? "").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function osAgora(){ return new Date().toLocaleString("pt-BR", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" }); }
function osPode(acao){ return OS_PERFIS[OS_PERFIL].acoes.includes(acao); }
function osNovoId(){ return Math.random().toString(36).slice(2, 10); }

function osExemplos(){
  const h = (perfil, texto, em) => ({ em, perfil, texto });
  return [
    { id:osNovoId(), numero:"OS-2026-0001", criadaEm:"2026-10-01", placa:"QXA1B23", frota:"F-012", km:"412.300", urgencia:"Urgente",
      problema:"Vazamento de ar no sistema de freio da carreta, caminhão parado no pátio.", status:"aprovacao",
      orcamentos:[
        { id:osNovoId(), prestador:"Auto Mecânica Silva", valor:3850, prazo:"2 dias", descricao:"Troca de válvula relé + 2 mangueiras", anexo:"orcamento_silva.pdf" },
        { id:osNovoId(), prestador:"Diesel Center", valor:4420, prazo:"1 dia", descricao:"Troca de válvula relé + revisão do sistema", anexo:"orc_dieselcenter.jpg" },
      ], aditivos:[], historico:[
        h("Manutenção","OS aberta","01/10/2026 08:12"), h("Manutenção","Orçamento de Auto Mecânica Silva anexado (R$ 3.850,00)","01/10/2026 10:40"),
        h("Manutenção","Orçamento de Diesel Center anexado (R$ 4.420,00)","01/10/2026 11:05"), h("Manutenção","Enviada para aprovação da diretoria","01/10/2026 11:06") ] },
    { id:osNovoId(), numero:"OS-2026-0002", criadaEm:"2026-09-28", placa:"PZK7C45", frota:"F-007", km:"288.910", urgencia:"Normal",
      problema:"Embreagem patinando em subida.", status:"execucao",
      orcamentos:[
        { id:osNovoId(), prestador:"Auto Mecânica Silva", valor:6200, prazo:"3 dias", descricao:"Kit embreagem completo + mão de obra", anexo:"orc_silva_embreagem.pdf" },
        { id:osNovoId(), prestador:"Mecânica Rota Norte", valor:5780, prazo:"4 dias", descricao:"Kit embreagem + mão de obra", anexo:"orc_rotanorte.pdf" },
      ],
      aprovacao:{ orcamentoId:null, prestador:"Mecânica Rota Norte", valor:5780, em:"29/09/2026 09:30", obs:"Menor preço, prazo aceitável." },
      aditivos:[ { id:osNovoId(), descricao:"Volante do motor com trinca, encontrado ao abrir — troca necessária", valor:1350, status:"pendente", em:"01/10/2026 15:20" } ],
      historico:[ h("Manutenção","OS aberta","28/09/2026 14:00"), h("Diretoria","Aprovada: Mecânica Rota Norte — R$ 5.780,00","29/09/2026 09:30"),
        h("Manutenção","Aditivo solicitado: volante do motor (R$ 1.350,00)","01/10/2026 15:20") ] },
    { id:osNovoId(), numero:"OS-2026-0003", criadaEm:"2026-09-20", placa:"QXA1B23", frota:"F-012", km:"409.870", urgencia:"Normal",
      problema:"Revisão do sistema elétrico — luzes da carreta falhando.", status:"pagamento",
      orcamentos:[
        { id:osNovoId(), prestador:"Eletro Diesel Pará", valor:980, prazo:"1 dia", descricao:"Revisão chicote + 4 lâmpadas", anexo:"orc_eletro.pdf" },
        { id:osNovoId(), prestador:"Diesel Center", valor:1150, prazo:"1 dia", descricao:"Revisão elétrica completa", anexo:"orc_dc_eletrica.pdf" },
      ],
      aprovacao:{ prestador:"Eletro Diesel Pará", valor:980, em:"21/09/2026 08:15", obs:"" },
      aditivos:[], execucao:{ fim:"23/09/2026 17:00", obs:"Serviço concluído e testado." },
      boleto:{ nf:"NF 4471", valor:1240, vencimento:"2026-10-10", em:"24/09/2026 10:00" },
      historico:[ h("Manutenção","OS aberta","20/09/2026 09:00"), h("Diretoria","Aprovada: Eletro Diesel Pará — R$ 980,00","21/09/2026 08:15"),
        h("Manutenção","Serviço concluído","23/09/2026 17:00"), h("Administração","Boleto lançado: NF 4471 — R$ 1.240,00 (DIVERGENTE)","24/09/2026 10:00") ] },
    { id:osNovoId(), numero:"OS-2026-0004", criadaEm:"2026-10-02", placa:"RTB3D90", frota:"F-021", km:"156.400", urgencia:"Emergência",
      problema:"Pneu estourado e aro danificado na rodovia.", status:"orcamento",
      orcamentos:[ { id:osNovoId(), prestador:"Borracharia BR-316", valor:1890, prazo:"Hoje", descricao:"Pneu novo + aro + socorro", anexo:"foto_orcamento.jpg" } ],
      aditivos:[], historico:[ h("Manutenção","OS aberta","02/10/2026 06:45"), h("Manutenção","Orçamento de Borracharia BR-316 anexado (R$ 1.890,00)","02/10/2026 07:10") ] },
  ];
}

function osCarregar(){
  if(OS_LISTA) return OS_LISTA;
  try{ const raw = localStorage.getItem(OS_STORAGE_KEY); OS_LISTA = raw ? JSON.parse(raw) : null; }catch(e){ OS_LISTA = null; }
  if(!Array.isArray(OS_LISTA)){ OS_LISTA = osExemplos(); osSalvar(); }
  return OS_LISTA;
}
function osSalvar(){ try{ localStorage.setItem(OS_STORAGE_KEY, JSON.stringify(OS_LISTA)); }catch(e){} }

// Cadastro de prestadores de serviço (usado no campo Prestador do orçamento)
let OS_PRESTADORES = null;
let OS_PREST_FORM = false;   // mostra o formulário de novo prestador dentro do orçamento
let OS_PREST_ULTIMO = "";    // prestador recém-cadastrado, já vem selecionado
function osPrestadores(){
  if(OS_PRESTADORES) return OS_PRESTADORES;
  try{ const raw = localStorage.getItem(OS_PREST_KEY); OS_PRESTADORES = raw ? JSON.parse(raw) : null; }catch(e){ OS_PRESTADORES = null; }
  if(!Array.isArray(OS_PRESTADORES)){
    OS_PRESTADORES = [
      { id:osNovoId(), nome:"Auto Mecânica Silva",  cnpj:"", telefone:"", especialidade:"Mecânica geral" },
      { id:osNovoId(), nome:"Borracharia BR-316",   cnpj:"", telefone:"", especialidade:"Pneus" },
      { id:osNovoId(), nome:"Diesel Center",        cnpj:"", telefone:"", especialidade:"Motor diesel" },
      { id:osNovoId(), nome:"Eletro Diesel Pará",   cnpj:"", telefone:"", especialidade:"Elétrica" },
      { id:osNovoId(), nome:"Mecânica Rota Norte",  cnpj:"", telefone:"", especialidade:"Mecânica geral" },
    ];
    osSalvarPrestadores();
  }
  return OS_PRESTADORES;
}
function osSalvarPrestadores(){ try{ localStorage.setItem(OS_PREST_KEY, JSON.stringify(OS_PRESTADORES)); }catch(e){} }

// Máscara de moeda: o usuário digita só números e o campo vira "R$ 1.234,56"
window.osMascaraBRL = (el) => {
  const d = el.value.replace(/\D/g, "").replace(/^0+/, "");
  el.value = d ? "R$ " + (parseInt(d, 10) / 100).toLocaleString("pt-BR", { minimumFractionDigits:2, maximumFractionDigits:2 }) : "";
};
// Placa: só letras maiúsculas e números, sem traço (ex: GCV0114)
window.osMascaraPlaca = (el) => { el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 7); };
function osRerender(){ document.getElementById("content").innerHTML = renderers.ordens(); window.scrollTo(0,0); }
function osGet(id){ return osCarregar().find(o=>o.id===id); }
function osLog(os, texto){ os.historico.push({ em:osAgora(), perfil:OS_PERFIS[OS_PERFIL].label, texto }); }
function osValorAprovado(os){
  if(!os.aprovacao) return 0;
  return os.aprovacao.valor + sumArr(os.aditivos.filter(a=>a.status==="aprovado").map(a=>a.valor));
}
function osDivergente(os){ return !!os.boleto && Math.abs(os.boleto.valor - osValorAprovado(os)) > 0.009; }
function osCampo(id){ const el = document.getElementById(id); return el ? el.value.trim() : ""; }
function osNum(id){
  // aceita "1.350,00" (padrão BR) e "1350.50"
  const s = osCampo(id).replace(/[R$\s]/g,"");
  const v = parseFloat(s.includes(",") ? s.replace(/\./g,"").replace(",", ".") : s);
  return isNaN(v) ? 0 : v;
}

window.osSetPerfil = (p) => { OS_PERFIL = p; osRerender(); };
window.osAbrir = (id) => { OS_SEL = id; osRerender(); };
window.osVoltar = () => { OS_SEL = null; osRerender(); };
window.osNova = () => { OS_SEL = "nova"; osRerender(); };
window.osResetarExemplos = () => {
  if(!confirm("Apagar todas as OS deste protótipo e recarregar os exemplos?")) return;
  OS_LISTA = osExemplos(); osSalvar(); OS_SEL = null; osRerender();
};

window.osCriar = () => {
  const placa = osCampo("os-placa").toUpperCase().replace(/[^A-Z0-9]/g, ""), frota = osCampo("os-frota").toUpperCase(), problema = osCampo("os-problema");
  if(!placa || !frota || !problema){ toast("Preencha a placa, a frota e a descrição do problema."); return; }
  if(placa.length !== 7){ toast("A placa deve ter 7 caracteres, ex: GCV0114."); return; }
  const lista = osCarregar(), ano = new Date().getFullYear();
  const seq = Math.max(0, ...lista.filter(o=>o.numero.startsWith(`OS-${ano}-`)).map(o=>parseInt(o.numero.slice(-4),10))) + 1;
  const os = { id:osNovoId(), numero:`OS-${ano}-${String(seq).padStart(4,"0")}`, criadaEm:new Date().toISOString().slice(0,10),
    placa, frota, km:osCampo("os-km"), urgencia:osCampo("os-urgencia") || "Normal", problema, status:"orcamento", orcamentos:[], aditivos:[], historico:[] };
  osLog(os, "OS aberta");
  lista.unshift(os); osSalvar(); OS_SEL = os.id; osRerender();
  toast(`${os.numero} criada ✓`);
};

window.osAddOrcamento = (id) => {
  const os = osGet(id), prestador = osCampo("os-orc-prestador"), valor = osNum("os-orc-valor");
  if(!prestador || !valor){ toast("Informe o prestador e o valor do orçamento."); return; }
  const arq = document.getElementById("os-orc-anexo");
  os.orcamentos.push({ id:osNovoId(), prestador, valor, prazo:osCampo("os-orc-prazo"), descricao:osCampo("os-orc-desc"), anexo: arq && arq.files[0] ? arq.files[0].name : "" });
  osLog(os, `Orçamento de ${prestador} anexado (${fmtBRL2(valor)})`);
  OS_PREST_ULTIMO = "";
  osSalvar(); osRerender();
};
// Re-renderiza mantendo o que já foi digitado no orçamento (valor, prazo, descrição)
function osRerenderMantendo(){
  const ids = ["os-orc-valor","os-orc-prazo","os-orc-desc"], vals = ids.map(osCampo);
  osRerender();
  ids.forEach((id,i)=>{ const el = document.getElementById(id); if(el) el.value = vals[i]; });
}
window.osTogglePrestForm = () => { OS_PREST_FORM = !OS_PREST_FORM; osRerenderMantendo(); };
window.osCadastrarPrestador = () => {
  const nome = osCampo("os-prest-nome");
  if(!nome){ toast("Informe o nome do prestador."); return; }
  if(osPrestadores().some(p=>p.nome.toLowerCase()===nome.toLowerCase())){ toast("Esse prestador já está cadastrado."); return; }
  osPrestadores().push({ id:osNovoId(), nome, cnpj:osCampo("os-prest-cnpj"), telefone:osCampo("os-prest-tel"), especialidade:osCampo("os-prest-esp") });
  osPrestadores().sort((a,b)=>a.nome.localeCompare(b.nome, "pt-BR"));
  osSalvarPrestadores();
  OS_PREST_ULTIMO = nome; OS_PREST_FORM = false;
  if(OS_SEL === "prestadores") osRerender(); else osRerenderMantendo();
  toast(`Prestador ${nome} cadastrado ✓`);
};
window.osRemoverPrestador = (pid) => {
  const p = osPrestadores().find(x=>x.id===pid);
  if(!p || !confirm(`Remover ${p.nome} do cadastro de prestadores?`)) return;
  OS_PRESTADORES = osPrestadores().filter(x=>x.id!==pid); osSalvarPrestadores(); osRerender();
};
window.osVerPrestadores = () => { OS_SEL = "prestadores"; osRerender(); };
window.osRemoverOrcamento = (id, orcId) => {
  const os = osGet(id); const o = os.orcamentos.find(x=>x.id===orcId);
  os.orcamentos = os.orcamentos.filter(x=>x.id!==orcId);
  osLog(os, `Orçamento de ${o.prestador} removido`); osSalvar(); osRerender();
};
window.osEnviarAprovacao = (id) => {
  const os = osGet(id);
  if(os.orcamentos.length === 0){ toast("Anexe pelo menos um orçamento."); return; }
  if(os.orcamentos.length < 2){
    const just = osCampo("os-just");
    if(!just){ toast("São necessários 2 orçamentos. Para enviar com 1, escreva a justificativa da exceção."); return; }
    os.excecao = just;
    osLog(os, `Enviada para aprovação com 1 orçamento — exceção: ${just}`);
  } else {
    osLog(os, "Enviada para aprovação da diretoria");
  }
  os.status = "aprovacao"; osSalvar(); osRerender();
};
window.osAprovar = (id) => {
  const os = osGet(id), escolhido = document.querySelector('input[name="os-escolha"]:checked');
  if(!escolhido){ toast("Escolha qual orçamento está sendo aprovado."); return; }
  const o = os.orcamentos.find(x=>x.id===escolhido.value);
  os.aprovacao = { orcamentoId:o.id, prestador:o.prestador, valor:o.valor, em:osAgora(), obs:osCampo("os-aprov-obs") };
  os.status = "execucao";
  osLog(os, `Aprovada: ${o.prestador} — ${fmtBRL2(o.valor)}${os.aprovacao.obs ? ` (${os.aprovacao.obs})` : ""}`);
  osSalvar(); osRerender();
};
window.osReprovar = (id) => {
  const os = osGet(id), obs = osCampo("os-aprov-obs");
  if(!obs){ toast("Escreva o motivo da reprovação no campo de observação."); return; }
  os.status = "reprovada"; osLog(os, `Reprovada: ${obs}`); osSalvar(); osRerender();
};
window.osDevolver = (id) => {
  const os = osGet(id), obs = osCampo("os-aprov-obs");
  os.status = "orcamento"; osLog(os, `Devolvida para novos orçamentos${obs ? `: ${obs}` : ""}`); osSalvar(); osRerender();
};
window.osSolicitarAditivo = (id) => {
  const os = osGet(id), descricao = osCampo("os-adit-desc"), valor = osNum("os-adit-valor");
  if(!descricao || !valor){ toast("Descreva o serviço extra e informe o valor."); return; }
  os.aditivos.push({ id:osNovoId(), descricao, valor, status:"pendente", em:osAgora() });
  osLog(os, `Aditivo solicitado: ${descricao} (${fmtBRL2(valor)})`); osSalvar(); osRerender();
};
window.osDecidirAditivo = (id, aditId, aprovado) => {
  const os = osGet(id), a = os.aditivos.find(x=>x.id===aditId);
  a.status = aprovado ? "aprovado" : "reprovado"; a.decididoEm = osAgora();
  osLog(os, `Aditivo ${aprovado ? "APROVADO" : "REPROVADO"}: ${a.descricao} (${fmtBRL2(a.valor)})`); osSalvar(); osRerender();
};
window.osConcluirExecucao = (id) => {
  const os = osGet(id);
  if(os.aditivos.some(a=>a.status==="pendente")){ toast("Há aditivo aguardando aprovação da diretoria."); return; }
  os.execucao = { fim:osAgora(), obs:osCampo("os-exec-obs") };
  os.status = "faturamento"; osLog(os, `Serviço concluído${os.execucao.obs ? `: ${os.execucao.obs}` : ""}`); osSalvar(); osRerender();
};
window.osLancarBoleto = (id) => {
  const os = osGet(id), nf = osCampo("os-bol-nf"), valor = osNum("os-bol-valor"), vencimento = osCampo("os-bol-venc");
  if(!nf || !valor || !vencimento){ toast("Informe a nota fiscal, o valor e o vencimento do boleto."); return; }
  os.boleto = { nf, valor, vencimento, em:osAgora() };
  os.status = "pagamento";
  osLog(os, `Boleto lançado: ${nf} — ${fmtBRL2(valor)}${osDivergente(os) ? ` (DIVERGENTE do aprovado ${fmtBRL2(osValorAprovado(os))})` : " (confere com o aprovado)"}`);
  osSalvar(); osRerender();
};
window.osPagar = (id) => {
  const os = osGet(id);
  if(osDivergente(os) && OS_PERFIL !== "diretoria"){ toast("Boleto divergente do valor aprovado — só a diretoria pode autorizar o pagamento."); return; }
  if(osDivergente(os) && !confirm(`O boleto (${fmtBRL2(os.boleto.valor)}) é diferente do aprovado (${fmtBRL2(osValorAprovado(os))}). Autorizar o pagamento mesmo assim?`)) return;
  os.pagamento = { data:new Date().toISOString().slice(0,10), em:osAgora() };
  os.status = "paga";
  osLog(os, `Pagamento registrado${osDivergente(os) ? " — divergência autorizada pela diretoria" : ""}`); osSalvar(); osRerender();
};
window.osExcluir = (id) => {
  const os = osGet(id);
  if(!confirm(`Excluir ${os.numero}?`)) return;
  OS_LISTA = osCarregar().filter(o=>o.id!==id); osSalvar(); OS_SEL = null; osRerender();
};

function osCartao(os){
  const pend = os.aditivos.some(a=>a.status==="pendente");
  const valor = os.aprovacao ? osValorAprovado(os) : (os.orcamentos.length ? Math.min(...os.orcamentos.map(o=>o.valor)) : 0);
  return `<div class="os-card" onclick="osAbrir('${os.id}')">
    <div class="os-card-top"><b>${os.numero}</b>${os.urgencia!=="Normal" ? `<span class="badge red">${osEsc(os.urgencia)}</span>` : ""}</div>
    <div class="os-card-placa">🚛 ${osEsc(os.placa)}${os.frota ? ` · Frota ${osEsc(os.frota)}` : ""}</div>
    <div class="os-card-desc">${osEsc(os.problema)}</div>
    <div class="os-card-foot">
      <span>${valor ? fmtBRL(valor) : "sem orçamento"}${os.aprovacao ? "" : os.orcamentos.length ? ` · ${os.orcamentos.length} orç.` : ""}</span>
      ${pend ? `<span class="badge amber">aditivo p/ aprovar</span>` : ""}
      ${osDivergente(os) && os.status==="pagamento" ? `<span class="badge red">boleto divergente</span>` : ""}
      ${os.status==="reprovada" ? `<span class="badge red">reprovada</span>` : ""}
    </div>
  </div>`;
}

function osQuadro(){
  const lista = osCarregar();
  const por = (st) => lista.filter(o=>o.status===st);
  const aguardAprov = por("aprovacao"), aditPend = lista.filter(o=>o.aditivos.some(a=>a.status==="pendente"));
  const aguardPag = por("pagamento"), diverg = aguardPag.filter(osDivergente);
  const abertas = lista.filter(o=>!["paga","reprovada"].includes(o.status));
  const valorAberto = sumArr(abertas.filter(o=>o.aprovacao).map(osValorAprovado));
  return `
    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">OS em aberto</div><div class="val">${abertas.length}</div><div class="delta flat">${fmtBRL(valorAberto)} já aprovados</div></div>
      <div class="kpi"><div class="lbl">Aguardando aprovação</div><div class="val" style="color:var(--${aguardAprov.length+aditPend.length?"amber":"ink"});">${aguardAprov.length + aditPend.length}</div><div class="delta flat">${aguardAprov.length} OS · ${aditPend.length} aditivo(s)</div></div>
      <div class="kpi"><div class="lbl">Em execução</div><div class="val">${por("execucao").length}</div></div>
      <div class="kpi"><div class="lbl">Aguardando pagamento</div><div class="val">${fmtBRL(sumArr(aguardPag.map(o=>o.boleto.valor)))}</div><div class="delta flat">${aguardPag.length} boleto(s)</div></div>
      <div class="kpi"><div class="lbl">Boletos divergentes</div><div class="val" style="color:var(--${diverg.length?"red":"green"});">${diverg.length}</div><div class="delta flat">valor ≠ aprovado</div></div>
    </div>
    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:16px;">
      ${osPode("abrir") ? `<button class="entry-submit" style="margin:0;" onclick="osNova()">+ Nova Ordem de Serviço</button>` : ""}
      <button class="os-btn" onclick="osVerPrestadores()">👷 Prestadores cadastrados (${osPrestadores().length})</button>
    </div>
    <div class="os-board">
      ${OS_COLUNAS.map(st=>{
        const itens = st==="paga" ? [...por("paga"), ...por("reprovada")] : por(st);
        return `<div class="os-col">
          <div class="os-col-head"><span>${OS_STATUS[st].label}</span><span class="os-count">${itens.length}</span></div>
          ${itens.length ? itens.map(osCartao).join("") : `<div class="os-vazio">—</div>`}
        </div>`;
      }).join("")}
    </div>`;
}

function osFormNova(){
  return `
    <button class="sub-tab-btn" onclick="osVoltar()">← Voltar ao quadro</button>
    <div class="panel os-form" style="margin-top:12px; max-width:720px;">
      <h3>Nova Ordem de Serviço</h3>
      <div class="hint">O número da OS é gerado agora — orçamentos, aprovação, nota e boleto ficam presos a ele.</div>
      <div class="os-grid">
        <label>Placa<input id="os-placa" placeholder="GCV0114" maxlength="7" style="text-transform:uppercase;" oninput="osMascaraPlaca(this)"></label>
        <label>Frota<input id="os-frota" placeholder="ex: F-012" style="text-transform:uppercase;" oninput="this.value=this.value.toUpperCase()"></label>
        <label>KM atual<input id="os-km" placeholder="412.300"></label>
        <label>Urgência<select id="os-urgencia"><option>Normal</option><option>Urgente</option><option>Emergência</option></select></label>
      </div>
      <label>Descrição do problema<textarea id="os-problema" rows="3" placeholder="O que aconteceu com o veículo?"></textarea></label>
      <label>Fotos do problema<input type="file" multiple accept="image/*"></label>
      <button class="entry-submit" onclick="osCriar()">Abrir OS</button>
    </div>`;
}

function osDetalhe(os){
  const idxAtual = os.status==="reprovada" ? -1 : OS_ETAPAS.findIndex(e=>e[0]===os.status);
  const menor = os.orcamentos.length ? Math.min(...os.orcamentos.map(o=>o.valor)) : 0;
  const maior = os.orcamentos.length ? Math.max(...os.orcamentos.map(o=>o.valor)) : 0;
  const aprovado = osValorAprovado(os);
  const podeOrcar = osPode("orcar") && os.status==="orcamento";
  const aprovando = osPode("aprovar") && os.status==="aprovacao";

  return `
    <button class="sub-tab-btn" onclick="osVoltar()">← Voltar ao quadro</button>
    <div class="panel" style="margin:12px 0 16px;">
      <div class="os-head">
        <div><h3 style="font-size:18px;">${os.numero} · 🚛 ${osEsc(os.placa)}${os.frota ? ` · Frota ${osEsc(os.frota)}` : ""}</h3>
          <div class="hint" style="margin:4px 0 0;">Aberta em ${fmtDataBR(os.criadaEm)}${os.km ? ` · KM ${osEsc(os.km)}` : ""} · Urgência: <b>${osEsc(os.urgencia)}</b></div></div>
        <div style="text-align:right;"><span class="badge ${OS_STATUS[os.status].cor}" style="font-size:12px;">${OS_STATUS[os.status].label}</span>
          ${os.aprovacao ? `<div class="hint" style="margin:6px 0 0;">Valor aprovado: <b style="color:var(--ink);">${fmtBRL2(aprovado)}</b></div>` : ""}</div>
      </div>
      <div class="os-steps">
        ${OS_ETAPAS.map((e,i)=>`<div class="os-step ${i<idxAtual?"done":i===idxAtual?"now":""}"><span>${i<idxAtual?"✓":i+1}</span>${e[1]}</div>`).join("")}
      </div>
      <p style="font-size:13px; margin-top:12px;"><b>Problema:</b> ${osEsc(os.problema)}</p>
    </div>

    <div class="panel" style="margin-bottom:16px;">
      <h3>Orçamentos ${os.orcamentos.length<2 && !os.aprovacao ? `<span class="badge amber">${os.orcamentos.length}/2 mínimo</span>` : ""}</h3>
      <div class="hint">${os.orcamentos.length>=2 ? `Diferença entre o maior e o menor: <b>${fmtBRL2(maior-menor)}</b> (${(maior?((maior-menor)/maior*100):0).toFixed(1)}%)` : "São necessários pelo menos 2 orçamentos para enviar à diretoria."}</div>
      ${os.orcamentos.length ? `
      <table>
        <thead><tr>${aprovando?"<th></th>":""}<th>Prestador</th><th>Descrição</th><th>Prazo</th><th>Anexo</th><th class="num">Valor</th>${podeOrcar?"<th></th>":""}</tr></thead>
        <tbody>${os.orcamentos.map(o=>{
          const escolhido = os.aprovacao && (os.aprovacao.orcamentoId===o.id || (!os.aprovacao.orcamentoId && os.aprovacao.prestador===o.prestador));
          return `<tr ${escolhido?'style="background:#E4F5EE;"':""}>
            ${aprovando?`<td><input type="radio" name="os-escolha" value="${o.id}" ${o.valor===menor?"checked":""}></td>`:""}
            <td><b>${osEsc(o.prestador)}</b>${escolhido?' <span class="badge green">aprovado</span>':""}</td>
            <td>${osEsc(o.descricao)}</td><td>${osEsc(o.prazo)}</td>
            <td>${o.anexo ? `📎 ${osEsc(o.anexo)}` : "—"}</td>
            <td class="num"><b>${fmtBRL2(o.valor)}</b>${o.valor===menor && os.orcamentos.length>1?' <span class="badge green">menor</span>':""}</td>
            ${podeOrcar?`<td><button class="os-link" onclick="osRemoverOrcamento('${os.id}','${o.id}')">remover</button></td>`:""}
          </tr>`; }).join("")}</tbody>
      </table>` : `<div class="empty-state" style="padding:18px;"><p>Nenhum orçamento anexado ainda.</p></div>`}
      ${os.excecao ? `<div class="os-alerta amber">⚠️ Enviada com 1 orçamento — justificativa: <b>${osEsc(os.excecao)}</b></div>` : ""}

      ${podeOrcar ? `
      <div class="os-sub os-form">
        <h4>Anexar orçamento</h4>
        <div class="os-grid">
          <label>Prestador<select id="os-orc-prestador">
            <option value="">Selecione o prestador</option>
            ${osPrestadores().map(p=>`<option ${p.nome===OS_PREST_ULTIMO?"selected":""}>${osEsc(p.nome)}</option>`).join("")}
          </select></label>
          <label>Valor<input id="os-orc-valor" inputmode="numeric" placeholder="R$ 0,00" oninput="osMascaraBRL(this)"></label>
          <label>Prazo<input id="os-orc-prazo" placeholder="ex: 2 dias"></label>
        </div>
        <button class="os-link" style="margin-top:6px;" onclick="osTogglePrestForm()">${OS_PREST_FORM ? "✕ cancelar cadastro" : "+ cadastrar novo prestador"}</button>
        ${OS_PREST_FORM ? `
        <div class="os-prest-form">
          <h4>Novo prestador de serviço</h4>
          <div class="os-grid">
            <label>Nome / Razão social<input id="os-prest-nome"></label>
            <label>CNPJ<input id="os-prest-cnpj" placeholder="00.000.000/0000-00"></label>
            <label>Telefone<input id="os-prest-tel" placeholder="(91) 90000-0000"></label>
            <label>Especialidade<input id="os-prest-esp" placeholder="ex: elétrica, pneus, motor"></label>
          </div>
          <button class="sub-tab-btn" style="margin-top:10px;" onclick="osCadastrarPrestador()">Salvar prestador</button>
        </div>` : ""}
        <label>Descrição (peças e mão de obra)<input id="os-orc-desc"></label>
        <label>Arquivo do orçamento (PDF ou foto)<input type="file" id="os-orc-anexo" accept=".pdf,image/*"></label>
        <button class="sub-tab-btn" style="margin-top:10px;" onclick="osAddOrcamento('${os.id}')">+ Adicionar orçamento</button>
      </div>
      ${osPode("enviar") ? `
      <div class="os-sub os-form">
        ${os.orcamentos.length===1 ? `<label>Justificativa para enviar com só 1 orçamento (ex: emergência na rodovia)<input id="os-just"></label>` : ""}
        <button class="entry-submit" ${os.orcamentos.length===0?"disabled style='opacity:.5'":""} onclick="osEnviarAprovacao('${os.id}')">Enviar para aprovação da diretoria →</button>
      </div>` : ""}` : ""}

      ${aprovando ? `
      <div class="os-sub os-form os-aprov">
        <h4>Decisão da diretoria</h4>
        <div class="hint">Marque na tabela o orçamento escolhido (o menor já vem marcado).</div>
        <label>Observação<input id="os-aprov-obs" placeholder="obrigatória para reprovar"></label>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
          <button class="os-btn green" onclick="osAprovar('${os.id}')">✓ Aprovar</button>
          <button class="os-btn" onclick="osDevolver('${os.id}')">↺ Pedir novos orçamentos</button>
          <button class="os-btn red" onclick="osReprovar('${os.id}')">✕ Reprovar</button>
        </div>
      </div>` : os.status==="aprovacao" ? `<div class="os-alerta amber">⏳ Aguardando decisão da diretoria.</div>` : ""}
    </div>

    ${os.aprovacao ? `
    <div class="panel" style="margin-bottom:16px;">
      <h3>Execução e serviços extras (aditivos)</h3>
      <div class="hint">Serviço extra encontrado durante a execução só pode ser feito depois de aprovado pela diretoria.</div>
      ${os.aditivos.length ? `
      <table>
        <thead><tr><th>Serviço extra</th><th>Solicitado em</th><th class="num">Valor</th><th>Situação</th></tr></thead>
        <tbody>${os.aditivos.map(a=>`<tr>
          <td>${osEsc(a.descricao)}</td><td>${a.em}</td><td class="num">${fmtBRL2(a.valor)}</td>
          <td>${a.status==="pendente"
            ? (osPode("aprovar") ? `<button class="os-btn green sm" onclick="osDecidirAditivo('${os.id}','${a.id}',true)">Aprovar</button> <button class="os-btn red sm" onclick="osDecidirAditivo('${os.id}','${a.id}',false)">Reprovar</button>` : `<span class="badge amber">aguardando diretoria</span>`)
            : `<span class="badge ${a.status==="aprovado"?"green":"red"}">${a.status}</span>`}</td>
        </tr>`).join("")}</tbody>
      </table>` : ""}
      <div class="os-resumo">
        <div>Orçamento aprovado<b>${fmtBRL2(os.aprovacao.valor)}</b><small>${osEsc(os.aprovacao.prestador)} · ${os.aprovacao.em}</small></div>
        <div>Aditivos aprovados<b>${fmtBRL2(aprovado - os.aprovacao.valor)}</b></div>
        <div>Total autorizado<b>${fmtBRL2(aprovado)}</b></div>
      </div>
      ${os.status==="execucao" && osPode("aditivo") ? `
      <div class="os-sub os-form">
        <h4>Solicitar serviço extra</h4>
        <div class="os-grid"><label style="grid-column:span 2;">Descrição<input id="os-adit-desc"></label><label>Valor<input id="os-adit-valor" inputmode="numeric" placeholder="R$ 0,00" oninput="osMascaraBRL(this)"></label></div>
        <button class="sub-tab-btn" style="margin-top:10px;" onclick="osSolicitarAditivo('${os.id}')">Enviar aditivo para aprovação</button>
      </div>` : ""}
      ${os.status==="execucao" && osPode("executar") ? `
      <div class="os-sub os-form">
        <label>Observação da conclusão<input id="os-exec-obs" placeholder="ex: serviço testado, peças trocadas guardadas"></label>
        <button class="entry-submit" onclick="osConcluirExecucao('${os.id}')">Marcar serviço como concluído →</button>
      </div>` : ""}
      ${os.execucao ? `<div class="os-alerta green">✓ Serviço concluído em ${os.execucao.fim}${os.execucao.obs ? ` — ${osEsc(os.execucao.obs)}` : ""}</div>` : ""}
    </div>` : ""}

    ${["faturamento","pagamento","paga"].includes(os.status) ? `
    <div class="panel" style="margin-bottom:16px;">
      <h3>Boleto e pagamento</h3>
      <div class="hint">Regra: boleto sem número de OS aprovada não se paga. O valor do boleto é conferido com o total autorizado.</div>
      ${os.boleto ? `
      <div class="os-resumo">
        <div>Nota / boleto<b>${osEsc(os.boleto.nf)}</b><small>lançado em ${os.boleto.em}</small></div>
        <div>Vencimento<b>${fmtDataBR(os.boleto.vencimento)}</b></div>
        <div>Valor do boleto<b style="color:var(--${osDivergente(os)?"red":"green"});">${fmtBRL2(os.boleto.valor)}</b><small>autorizado: ${fmtBRL2(aprovado)}</small></div>
      </div>
      ${osDivergente(os) ? `<div class="os-alerta red">⛔ Boleto ${fmtBRL2(os.boleto.valor - aprovado)} ${os.boleto.valor>aprovado?"acima":"abaixo"} do valor autorizado. Só a diretoria pode liberar o pagamento.</div>` : `<div class="os-alerta green">✓ Valor do boleto confere com o autorizado.</div>`}` : ""}
      ${os.status==="faturamento" && osPode("boleto") ? `
      <div class="os-sub os-form">
        <h4>Lançar nota e boleto</h4>
        <div class="os-grid">
          <label>Nº da nota fiscal<input id="os-bol-nf"></label>
          <label>Valor do boleto<input id="os-bol-valor" inputmode="numeric" placeholder="${fmtBRL2(aprovado)}" oninput="osMascaraBRL(this)"></label>
          <label>Vencimento<input type="date" id="os-bol-venc"></label>
        </div>
        <label>Arquivo do boleto / NF<input type="file" accept=".pdf,image/*"></label>
        <button class="entry-submit" onclick="osLancarBoleto('${os.id}')">Lançar boleto</button>
      </div>` : os.status==="faturamento" ? `<div class="os-alerta amber">⏳ Aguardando a administração lançar a nota e o boleto.</div>` : ""}
      ${os.status==="pagamento" && osPode("pagar") ? `<button class="os-btn green" style="margin-top:12px;" onclick="osPagar('${os.id}')">💵 Registrar pagamento</button>` : ""}
      ${os.pagamento ? `<div class="os-alerta green">✓ Pago em ${fmtDataBR(os.pagamento.data)} — OS encerrada.</div>` : ""}
    </div>` : ""}

    <div class="panel" style="margin-bottom:16px;">
      <h3>Linha do tempo</h3>
      <div class="hint">Tudo o que aconteceu nesta OS, quem fez e quando.</div>
      <ul class="os-timeline">${[...os.historico].reverse().map(h=>`<li><span>${h.em}</span><b>${osEsc(h.perfil)}</b> — ${osEsc(h.texto)}</li>`).join("")}</ul>
      ${osPode("excluir") ? `<button class="os-link" style="margin-top:10px; color:var(--red);" onclick="osExcluir('${os.id}')">Excluir esta OS</button>` : ""}
    </div>`;
}

function osTelaPrestadores(){
  const podeEditar = osPode("orcar");
  const usos = (nome) => osCarregar().filter(o=>o.orcamentos.some(x=>x.prestador===nome)).length;
  return `
    <button class="sub-tab-btn" onclick="osVoltar()">← Voltar ao quadro</button>
    <div class="panel" style="margin-top:12px;">
      <h3>Prestadores de serviço</h3>
      <div class="hint">Lista usada no campo "Prestador" dos orçamentos.</div>
      <table>
        <thead><tr><th>Nome</th><th>CNPJ</th><th>Telefone</th><th>Especialidade</th><th class="num">OS com orçamento</th>${podeEditar?"<th></th>":""}</tr></thead>
        <tbody>${osPrestadores().map(p=>`<tr>
          <td><b>${osEsc(p.nome)}</b></td><td>${osEsc(p.cnpj)||"—"}</td><td>${osEsc(p.telefone)||"—"}</td><td>${osEsc(p.especialidade)||"—"}</td>
          <td class="num">${usos(p.nome)}</td>
          ${podeEditar?`<td><button class="os-link" onclick="osRemoverPrestador('${p.id}')">remover</button></td>`:""}
        </tr>`).join("")}</tbody>
      </table>
      ${podeEditar ? `
      <div class="os-sub os-form">
        <h4>Cadastrar novo prestador</h4>
        <div class="os-grid">
          <label>Nome / Razão social<input id="os-prest-nome"></label>
          <label>CNPJ<input id="os-prest-cnpj" placeholder="00.000.000/0000-00"></label>
          <label>Telefone<input id="os-prest-tel" placeholder="(91) 90000-0000"></label>
          <label>Especialidade<input id="os-prest-esp" placeholder="ex: elétrica, pneus, motor"></label>
        </div>
        <button class="entry-submit" onclick="osCadastrarPrestador()">Salvar prestador</button>
      </div>` : ""}
    </div>`;
}

renderers.ordens = () => {
  osCarregar();
  const telaEspecial = OS_SEL==="nova" || OS_SEL==="prestadores";
  const os = OS_SEL && !telaEspecial ? osGet(OS_SEL) : null;
  if(OS_SEL && !telaEspecial && !os) OS_SEL = null;
  return `
    <div class="page-head">
      <h2>Ordens de Serviço</h2>
      <p>Pedido de serviço → orçamentos → aprovação da diretoria → execução → boleto → pagamento</p>
    </div>
    <div class="os-proto">
      <div><b>🧪 Protótipo para avaliação.</b> Os dados ficam salvos só neste navegador. Use "Ver como" para testar cada perfil.</div>
      <div class="os-perfis">
        <span>Ver como:</span>
        ${Object.entries(OS_PERFIS).map(([k,p])=>`<button class="sub-tab-btn ${OS_PERFIL===k?"active":""}" onclick="osSetPerfil('${k}')">${p.label}</button>`).join("")}
        <button class="os-link" onclick="osResetarExemplos()">recarregar exemplos</button>
      </div>
    </div>
    ${OS_SEL==="nova" && osPode("abrir") ? osFormNova() : OS_SEL==="prestadores" ? osTelaPrestadores() : os ? osDetalhe(os) : osQuadro()}`;
};

/* -------------------- STATUS DA FROTA (PROTÓTIPO) --------------------
   Substitui a mensagem diária de WhatsApp: cada líder, no tablet, confirma atividade, motorista e
   status de cada caminhão; o diretor vê o resumo do dia por atividade e clica para ver os caminhões.
   Protótipo: dados no localStorage deste navegador (depois migra para o Supabase). */
const FROTA_KEY = "avance_frota_status_v1";
// A ordem aqui é a ordem dos grupos na mensagem do WhatsApp (igual à lista dos líderes)
const FROTA_ATIVIDADES = [
  { chave:"honda",    label:"Operação Honda",        cor:"#D0021B" },
  { chave:"reserva",  label:"Disponível",            cor:"#5B5F6B" },
  { chave:"entregas", label:"Entregas / Coletas",    cor:"#2E6DB0" },
  { chave:"manobra",  label:"Manobra Pátio Externo", cor:"#8E2EB0" },
  { chave:"porto",    label:"Porto",                 cor:"#1C9A6C" },
  { chave:"oficina",  label:"Oficina",               cor:"#E1971F" },
];
let FROTA_NUMERACAO = (()=>{ try{ return localStorage.getItem("avance_frota_numeracao") || "continua"; }catch(e){ return "continua"; } })();
const FROTA_STATUS = [
  { chave:"operando",   label:"Operando",       badge:"green" },
  { chave:"manutencao", label:"Em manutenção",  badge:"amber" },
  { chave:"parado",     label:"Parado",         badge:"red"   },
  { chave:"semmot",     label:"Sem motorista",  badge:"gray"  },
];

let FROTA = null;              // { veiculos:[...], dias:{ "AAAA-MM-DD": { [id]: registro } } }
let FROTA_ABA = "painel";      // painel | lider | cadastro
let FROTA_DATA = frotaHojeISO();
let FROTA_ATIV_SEL = null;     // atividade clicada no painel
let FROTA_FILTRO_LIDER = "todas";
let FROTA_BUSCA = "";

// Lista inicial (mensagem de WhatsApp de 06/10/26) — usada para popular o cadastro na primeira vez
const FROTA_LISTA_INICIAL = [
  ["honda",["GCV0C68","JORGE"],["GCV3D41","ANDREY"],["GCV3D98","JOÃO PAULO"],["GCV3D93","IZAMAR"],["GCV3D79","IVALDIR"],["GCV0G21","OSVALDO"],
    ["GCV3G01","EDILAN"],["GCV3D31","ADALBERTO"],["GCV3A07","FABRÍCIO"],["GCV3B43","JOSIAS"],["GCVOF34","MARCO"],["GCV3E41","LUCAS"],
    ["GCV3C03","MICAEL"],["GCV3243","MANOEL"],["GCV3D54","NILTON"],["GCV3J65","STÊNIO"]],
  ["entregas",["GCV3D82","TOMÉ"],["GCV3B62","JACKSON"],["GCV3284","WALTER"],["GCV3E24","MARCOS RAFAEL"],["GCV3D62","ALLAN"],["GCV3247","BRUNO"],
    ["0C41","AMILDO"],["GCV3E51","ALEXANDRE"],["GCV3D62","ALLAN"],["GCV3A13","ALEX"],["GCV0C74","GABRIEL"],["GHA3A01","EDUARDO"]],
  ["manobra",["NSI1680","NILSON"]],
  ["porto",["HHK5E27","MESSIAS"],["NOS0950","JEREMIAS"],["NOS3230","DELANE"],["CDM3D19","THIAGO"],["CLU5945","ZEQUINHA"],["NEL5F78","NALDO"],["GCV3C74","GOUVEIA"]],
  ["oficina",["EPU9E14",""],["GCV3D63",""],["GCV3D75",""],["ATP3057","","Curuba"],["ATP3089","","Manut. Avance"],["TUG MASTER",""]],
];
function frotaListaInicial(){
  const veiculos = []; let ordem = 1;
  FROTA_LISTA_INICIAL.forEach(([ativ, ...itens])=>itens.forEach(([placa, motorista, obs])=>{
    veiculos.push({ id:osNovoId(), ordem:ordem++, placa, motorista, atividadePadrao:ativ, obsPadrao:obs||"" });
  }));
  return veiculos;
}
function frotaHojeISO(){ const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function frotaHora(ts){ const d = ts ? new Date(ts) : new Date(); return d.toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" }); }

// Com Supabase configurado, tudo vive nas tabelas frota_veiculos / frota_status e é compartilhado
// entre os usuários (líder lança no tablet, diretor vê no computador). Sem banco, cai para o
// localStorage deste navegador (modo local de testes).
const FROTA_DB = !!sb;
let FROTA_ASSINATURA = "";
let FROTA_PENDENTE_RERENDER = false;

function frotaCarregar(){
  if(FROTA) return FROTA;
  if(FROTA_DB){
    FROTA = { veiculos:[], dias:{}, carregando:true };
    frotaBuscarDb();
    return FROTA;
  }
  try{ const raw = localStorage.getItem(FROTA_KEY); FROTA = raw ? JSON.parse(raw) : null; }catch(e){ FROTA = null; }
  if(!FROTA || !Array.isArray(FROTA.veiculos)){ FROTA = { veiculos:frotaListaInicial(), dias:{} }; frotaSalvar(); }
  return FROTA;
}
function frotaSalvar(){ if(FROTA_DB) return; try{ localStorage.setItem(FROTA_KEY, JSON.stringify(FROTA)); }catch(e){} }

async function frotaBuscarDb(silencioso){
  if(!FROTA_DB) return;
  const desde = new Date(FROTA_DATA + "T12:00:00"); desde.setDate(desde.getDate() - 45);
  const desdeISO = desde.toISOString().slice(0,10);
  const [veic, st, rest] = await Promise.all([
    sb.from("frota_veiculos").select("*").order("ordem"),
    sb.from("frota_status").select("*").gte("data", desdeISO).lte("data", FROTA_DATA),
    sb.from("frota_restricoes").select("id,veiculo_id,descricao,tem_foto,aberta_em,aberta_por").is("resolvida_em", null),
  ]);
  const erro = veic.error || st.error;
  if(erro){
    FROTA = { veiculos:[], dias:{}, carregando:false, erro: erro.message };
    if(!silencioso) frotaRerenderSeguro();
    return;
  }
  const dias = {};
  st.data.forEach(r=>{
    (dias[r.data] = dias[r.data] || {})[r.veiculo_id] = { atividade:r.atividade, motorista:r.motorista||"", status:r.status, obs:r.obs||"",
      confirmado:true, em:frotaHora(r.atualizado_em), por:(r.atualizado_por||"").split("@")[0] };
  });
  const novo = { veiculos: veic.data.map(v=>({ id:v.id, ordem:v.ordem, placa:v.placa, motorista:v.motorista||"", atividadePadrao:v.atividade_padrao||"reserva", obsPadrao:v.obs||"" })),
                 dias, carregando:false, atualizadoEm:frotaHora(), dataCarregada:FROTA_DATA,
                 restricoes: rest.error ? [] : rest.data.map(r=>({ id:r.id, veiculoId:r.veiculo_id, descricao:r.descricao||"", temFoto:!!r.tem_foto, abertaEm:r.aberta_em, abertaPor:(r.aberta_por||"").split("@")[0] })),
                 erroRest: rest.error ? rest.error.message : null };
  const assinatura = JSON.stringify([novo.veiculos, novo.dias, novo.restricoes]);
  const mudou = assinatura !== FROTA_ASSINATURA;
  FROTA_ASSINATURA = assinatura;
  FROTA = novo;
  if(!silencioso || mudou) frotaRerenderSeguro();
  else { const el = document.getElementById("frota-sync"); if(el) el.textContent = `atualizado às ${frotaHora()}`; }
}

// Não redesenha a tela enquanto alguém está digitando (perderia o texto); tenta de novo ao sair do campo
function frotaRerenderSeguro(){
  if(document.querySelector('nav.menu button.active')?.dataset.page !== "frota") return;
  const foco = document.activeElement;
  if(foco && foco.closest && foco.closest("#content") && /INPUT|TEXTAREA|SELECT/.test(foco.tagName) && foco.id !== "frota-busca"){
    FROTA_PENDENTE_RERENDER = true; return;
  }
  FROTA_PENDENTE_RERENDER = false;
  frotaRerender();
}
document.addEventListener("focusout", ()=>{ if(FROTA_PENDENTE_RERENDER) setTimeout(frotaRerenderSeguro, 50); });
setInterval(()=>{
  if(FROTA_DB && document.visibilityState === "visible" && document.querySelector('nav.menu button.active')?.dataset.page === "frota") frotaBuscarDb(true);
}, 30000);

function frotaRerender(){ const y = window.scrollY; document.getElementById("content").innerHTML = renderers.frota(); window.scrollTo(0,y); requestAnimationFrame(frotaGraficoDiario); }

// Colunas empilhadas: uma coluna por dia (até 15 dias com lançamento, terminando no dia
// selecionado), um bloco por atividade nas mesmas cores dos cartões, quantidade dentro do bloco
// e o total no topo.
function frotaGraficoDiario(){
  const el = document.getElementById("ch-frota-diario");
  if(!el || typeof Chart === "undefined") return;
  const F = frotaCarregar();
  const dias = [...new Set([...Object.keys(F.dias).filter(d=>d<=FROTA_DATA), FROTA_DATA])].sort().slice(-15);
  const SEM = ["dom","seg","ter","qua","qui","sex","sáb"];
  const rotulo = (d) => { const dt = new Date(d+"T12:00:00"); return [`${d.slice(8,10)}/${d.slice(5,7)}`, SEM[dt.getDay()]]; };
  const porDia = dias.map(d=>{ const its = frotaDoDia(d); const c = {}; its.forEach(({r})=>{ c[r.atividade] = (c[r.atividade]||0)+1; }); return { c, total:its.length }; });
  const totais = porDia.map(p=>p.total);

  const totalNoTopo = {
    id:"frotaTotais",
    afterDatasetsDraw(chart){
      const { ctx } = chart, meta = chart.getDatasetMeta(chart.data.datasets.length-1);
      ctx.save(); ctx.font = "700 11px Inter, system-ui, sans-serif"; ctx.fillStyle = COLORS.ink; ctx.textAlign = "center";
      meta.data.forEach((bar,i)=>{
        let topo = Infinity;
        chart.data.datasets.forEach((_,di)=>{ const b = chart.getDatasetMeta(di).data[i]; if(b && chart.data.datasets[di].data[i]) topo = Math.min(topo, b.y); });
        if(topo < Infinity) ctx.fillText(totais[i], bar.x, topo - 6);
      });
      ctx.restore();
    }
  };

  mkChart("ch-frota-diario", {
    type:"bar",
    data:{ labels:dias.map(rotulo), datasets:FROTA_ATIVIDADES.map(a=>({
      label:a.label, data:porDia.map(p=>p.c[a.chave]||0), backgroundColor:a.cor,
      borderColor:"#fff", borderWidth:2, borderSkipped:false, borderRadius:5, maxBarThickness:48,
    })) },
    options:{ responsive:true, maintainAspectRatio:false,
      onClick:(_e, els)=>{ if(els.length) frotaSetData(dias[els[0].index]); },
      onHover:(e, els)=>{ e.native.target.style.cursor = els.length ? "pointer" : "default"; },
      plugins:{
        legend:{ position:"bottom", labels:{ boxWidth:10, usePointStyle:true, pointStyle:"rectRounded", padding:14 } },
        tooltip:{ mode:"index", filter:(it)=>it.raw>0,
          callbacks:{ title:(its)=>`${its[0].label.join(" · ")} — ${totais[its[0].dataIndex]} caminhões`, label:(it)=>` ${it.dataset.label}: ${it.raw}` } },
        datalabels:{ color:"#fff", font:{ size:11, weight:700 },
          // só escreve o número quando o bloco tem altura para ele (o resto aparece no tooltip)
          display:(ctx)=>{ const v = ctx.dataset.data[ctx.dataIndex]; const y = ctx.chart.scales.y; return v > 0 && Math.abs(y.getPixelForValue(0) - y.getPixelForValue(v)) >= 16; },
          formatter:(v)=>v }
      },
      layout:{ padding:{ top:20 } },
      scales:{
        x:{ stacked:true, grid:{ display:false }, ticks:{ font:(c)=>({ weight: dias[c.index]===FROTA_DATA ? 700 : 400 }) } },
        y:{ stacked:true, beginAtZero:true, grid:{ color:COLORS.grid }, ticks:{ precision:0 } }
      } },
    plugins:[totalNoTopo]
  });
}
initCharts.frota = frotaGraficoDiario;
function frotaAtiv(ch){ return FROTA_ATIVIDADES.find(a=>a.chave===ch) || FROTA_ATIVIDADES.find(a=>a.chave==="reserva"); }
function frotaStatus(ch){ return FROTA_STATUS.find(s=>s.chave===ch) || FROTA_STATUS[0]; }
function frotaDataBR(iso){ const [a,m,d] = iso.split("-"); return `${d}/${m}/${a.slice(2)}`; }
function frotaPodeCadastrar(){ return !FROTA_DB || MEU_PAPEL === "diretor"; }

// Registro do dia de um caminhão: se ainda não foi lançado nesse dia, parte do último dia anterior
// lançado (ou do cadastro), marcado como "não confirmado".
function frotaRegistro(v, data){
  const F = frotaCarregar();
  if(F.dias[data] && F.dias[data][v.id]) return F.dias[data][v.id];
  const anteriores = Object.keys(F.dias).filter(d=>d<data && F.dias[d][v.id]).sort();
  const base = anteriores.length ? F.dias[anteriores[anteriores.length-1]][v.id]
             : { atividade:v.atividadePadrao, motorista:v.motorista, status: v.atividadePadrao==="oficina" ? "manutencao" : "operando", obs:v.obsPadrao||"" };
  return { atividade:base.atividade, motorista:base.motorista, status:base.status, obs:base.obs, confirmado:false };
}
function frotaVeiculosOrdenados(){ return [...frotaCarregar().veiculos].sort((a,b)=>a.ordem-b.ordem); }
function frotaDoDia(data){ return frotaVeiculosOrdenados().map(v=>({ v, r:frotaRegistro(v, data) })); }

async function frotaGravarStatus(regs){
  if(!FROTA_DB) return true;
  const agora = new Date().toISOString();
  const { error } = await sb.from("frota_status").upsert(regs.map(({ id, r })=>({
    data:FROTA_DATA, veiculo_id:id, atividade:r.atividade, motorista:r.motorista||null, status:r.status, obs:r.obs||null,
    atualizado_por:MEU_EMAIL, atualizado_em:agora
  })), { onConflict:"data,veiculo_id" });
  if(error){ toast("⚠ Não salvou no banco: " + error.message); frotaBuscarDb(); return false; }
  return true;
}

/* ---------- Restrições: caminhão operando com restrição (pendência até ser resolvida) ----------
   Uma restrição aberta por caminhão: descrição + UMA foto (reduzida no navegador, até 1024px). Fica como
   pendência no painel até alguém marcar "Resolvida". Tabela frota_restricoes (a foto só é baixada ao abrir). */
let FROTA_REST_EDIT = null, FROTA_REST_DESC = "", FROTA_REST_FOTO = null;
function frotaRestricoes(){ return frotaCarregar().restricoes || []; }
function frotaRestricao(vid){ return frotaRestricoes().find(x=>x.veiculoId===vid) || null; }
function frotaDesdeTxt(x){ const d = nfeDias(x.abertaEm, frotaHojeISO()); return `desde ${frotaDataBR(x.abertaEm)} · ${d<=0 ? "hoje" : `há ${d} dia(s)`}${x.abertaPor ? ` · ${osEsc(x.abertaPor)}` : ""}`; }
window.frotaRestAbrirForm = (vid) => { const x = frotaRestricao(vid); FROTA_REST_EDIT = vid; FROTA_REST_DESC = x ? x.descricao : ""; FROTA_REST_FOTO = null; frotaRerender(); setTimeout(()=>document.getElementById("frest-desc")?.focus(), 30); };
window.frotaRestCancelar = () => { FROTA_REST_EDIT = null; FROTA_REST_FOTO = null; frotaRerender(); };
window.frotaRestFoto = (input) => {
  const f = input.files && input.files[0]; if(!f) return;
  const url = URL.createObjectURL(f), img = new Image();
  img.onload = () => {
    const k = Math.min(1, 1024 / Math.max(img.width, img.height)), c = document.createElement("canvas");
    c.width = Math.round(img.width*k); c.height = Math.round(img.height*k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    FROTA_REST_FOTO = c.toDataURL("image/jpeg", 0.72); URL.revokeObjectURL(url);
    const pv = document.getElementById("frest-prev"); if(pv){ pv.src = FROTA_REST_FOTO; pv.style.display = "block"; }
  };
  img.onerror = () => { toast("Não foi possível ler a imagem."); URL.revokeObjectURL(url); };
  img.src = url;
};
window.frotaRestSalvar = async (vid) => {
  const desc = (document.getElementById("frest-desc")?.value ?? FROTA_REST_DESC).trim();
  if(!desc){ toast("Descreva qual é a restrição."); return; }
  const F = frotaCarregar(); F.restricoes = F.restricoes || [];
  const atual = frotaRestricao(vid), por = (MEU_EMAIL||"").split("@")[0], hoje = frotaHojeISO();
  if(FROTA_DB){
    const campos = { descricao:desc, atualizado_por:MEU_EMAIL, atualizado_em:new Date().toISOString(), ...(FROTA_REST_FOTO ? { foto:FROTA_REST_FOTO, tem_foto:true } : {}) };
    const { data, error } = await (atual ? sb.from("frota_restricoes").update(campos).eq("id", atual.id).select("id").single()
      : sb.from("frota_restricoes").insert({ ...campos, veiculo_id:vid, aberta_em:hoje, aberta_por:MEU_EMAIL }).select("id").single());
    if(error){ toast(/frota_restricoes/i.test(error.message) ? "⚠ Falta rodar o SQL das restrições da frota no Supabase." : "⚠ Não salvou: " + error.message); return; }
    if(atual){ atual.descricao = desc; if(FROTA_REST_FOTO) atual.temFoto = true; }
    else F.restricoes.push({ id:data.id, veiculoId:vid, descricao:desc, temFoto:!!FROTA_REST_FOTO, abertaEm:hoje, abertaPor:por });
  } else {
    if(atual){ atual.descricao = desc; if(FROTA_REST_FOTO){ atual.foto = FROTA_REST_FOTO; atual.temFoto = true; } }
    else F.restricoes.push({ id:osNovoId(), veiculoId:vid, descricao:desc, temFoto:!!FROTA_REST_FOTO, foto:FROTA_REST_FOTO, abertaEm:hoje, abertaPor:por });
    frotaSalvar();
  }
  FROTA_REST_EDIT = null; FROTA_REST_FOTO = null; toast("Restrição registrada ✓"); frotaRerender();
};
window.frotaRestResolver = async (id) => {
  const F = frotaCarregar(), x = frotaRestricoes().find(r=>r.id===id); if(!x) return;
  const v = F.veiculos.find(y=>y.id===x.veiculoId);
  if(!confirm(`A restrição do ${v ? v.placa : "caminhão"} foi resolvida?\n\n"${x.descricao}"`)) return;
  if(FROTA_DB){
    const { error } = await sb.from("frota_restricoes").update({ resolvida_em:frotaHojeISO(), resolvida_por:MEU_EMAIL, atualizado_por:MEU_EMAIL, atualizado_em:new Date().toISOString() }).eq("id", id);
    if(error){ toast("⚠ Não salvou: " + error.message); return; }
  }
  F.restricoes = F.restricoes.filter(r=>r.id!==id); frotaSalvar(); toast("Restrição resolvida ✓"); frotaRerender();
};
window.frotaRestVerFoto = async (id) => {
  const x = frotaRestricoes().find(r=>r.id===id); if(!x) return;
  let src = x.foto;
  if(!src && FROTA_DB){ const { data, error } = await sb.from("frota_restricoes").select("foto").eq("id", id).single(); if(error){ toast("⚠ " + error.message); return; } src = data.foto; }
  if(!src){ toast("Sem foto."); return; }
  const v = frotaCarregar().veiculos.find(y=>y.id===x.veiculoId);
  const d = document.createElement("div"); d.className = "frota-foto-modal"; d.onclick = () => d.remove();
  d.innerHTML = `<div><img src="${src}" alt="Foto da restrição"><p><b>${osEsc(v ? v.placa : "")}</b> — ${osEsc(x.descricao)}<br><small>${frotaDesdeTxt(x)} · toque para fechar</small></p></div>`;
  document.body.appendChild(d);
};
// Bloco da restrição no cartão do líder
function frotaRestCardHTML(v){
  const x = frotaRestricao(v.id), editando = FROTA_REST_EDIT===v.id;
  const form = editando ? `<div class="frota-rest-form os-form">
      <label>Qual é a restrição?<textarea id="frest-desc" rows="2" placeholder="ex: ar-condicionado com defeito, pneu com desgaste, lanterna queimada..." oninput="FROTA_REST_DESC=this.value">${osEsc(FROTA_REST_DESC)}</textarea></label>
      <label>📷 Foto (uma) <small>${x && x.temFoto ? "— escolher outra substitui a atual" : "(opcional)"}</small><input type="file" accept="image/*" onchange="frotaRestFoto(this)"></label>
      <img id="frest-prev" class="frota-rest-prev" src="${FROTA_REST_FOTO||""}" alt="" style="${FROTA_REST_FOTO ? "" : "display:none;"}">
      <div class="frota-rest-acoes" style="margin-top:8px;"><button class="os-btn sm" onclick="frotaRestSalvar('${v.id}')">💾 Salvar restrição</button><button class="os-link" onclick="frotaRestCancelar()">cancelar</button></div>
    </div>` : "";
  if(x) return `<div class="frota-rest"><div>⚠️ <b>Com restrição:</b> ${osEsc(x.descricao)}</div><div class="hint" style="margin:2px 0 6px;">${frotaDesdeTxt(x)}</div>
    ${editando ? form : `<div class="frota-rest-acoes">${x.temFoto ? `<button class="os-link" onclick="frotaRestVerFoto('${x.id}')">📷 ver foto</button>` : ""}<button class="os-link" onclick="frotaRestAbrirForm('${v.id}')">✏️ editar</button><button class="os-btn sm green" onclick="frotaRestResolver('${x.id}')">✅ Resolvida</button></div>`}</div>`;
  return editando ? `<div class="frota-rest novo">${form}</div>` : `<button class="frota-rest-add" onclick="frotaRestAbrirForm('${v.id}')">⚠️ Operando com restrição? Informar</button>`;
}
// Pendências (painel do diretor): caminhões com restrição em aberto, da mais antiga para a mais nova
function frotaPendenciasHTML(itens){
  const F = frotaCarregar();
  const cab = `<h3>⚠️ Pendências — caminhões com restrição</h3>`;
  if(F.erroRest) return `<div class="panel" style="margin-bottom:16px;">${cab}<div class="os-alerta amber">⚠️ Não foi possível carregar as restrições: ${osEsc(F.erroRest)}. Se falar em tabela inexistente ("frota_restricoes"), rode o SQL das restrições da frota no Supabase.</div></div>`;
  const ls = itens.map(i=>({ ...i, x:frotaRestricao(i.v.id) })).filter(i=>i.x).sort((a,b)=>(a.x.abertaEm||"").localeCompare(b.x.abertaEm||""));
  return `<div class="panel" style="margin-bottom:16px;">${cab}
    <div class="hint">Caminhões operando com alguma restrição. Saem da lista quando alguém marca "Resolvida".</div>
    ${ls.length ? `<div style="overflow-x:auto;"><table>
      <thead><tr><th>#</th><th>Placa</th><th>Onde está</th><th>Motorista</th><th>Status</th><th>Restrição</th><th>Foto</th><th>Aberta</th><th></th></tr></thead>
      <tbody>${ls.map(({v,r,x})=>{ const d = nfeDias(x.abertaEm, frotaHojeISO()), a = frotaAtiv(r.atividade); return `<tr>
        <td>${String(v.ordem).padStart(2,"0")}</td><td><b>${osEsc(v.placa)}</b></td>
        <td><span class="nfe-dot" style="--c:${a.cor};"></span>${a.label}</td><td>${osEsc(r.motorista)||"—"}</td>
        <td><span class="badge ${frotaStatus(r.status).badge}">${frotaStatus(r.status).label}</span></td>
        <td><b>${osEsc(x.descricao)}</b></td>
        <td>${x.temFoto ? `<button class="os-link" onclick="frotaRestVerFoto('${x.id}')">📷 ver</button>` : "—"}</td>
        <td style="white-space:nowrap;">${frotaDataBR(x.abertaEm)}<div class="hint" style="margin:0; ${d>7 ? "color:var(--red); font-weight:700;" : ""}">${d<=0 ? "hoje" : `há ${d} dia(s)`}${x.abertaPor ? ` · ${osEsc(x.abertaPor)}` : ""}</div></td>
        <td><button class="os-btn sm green" onclick="frotaRestResolver('${x.id}')">✅ Resolvida</button></td>
      </tr>`; }).join("")}</tbody></table></div>` : `<div class="empty-state" style="padding:14px;"><p>Nenhum caminhão com restrição. ✓</p></div>`}
  </div>`;
}

window.frotaSetAba = (a) => { FROTA_ABA = a; frotaRerender(); };
window.frotaSetData = (d) => { if(d){ FROTA_DATA = d; if(FROTA_DB){ FROTA.carregando = true; frotaRerender(); frotaBuscarDb(); } else frotaRerender(); } };
window.frotaAtualizarAgora = () => { frotaBuscarDb(); toast("Atualizando..."); };
window.frotaSelAtiv = (a) => { FROTA_ATIV_SEL = FROTA_ATIV_SEL===a ? null : a; frotaRerender(); };
window.frotaFiltroLider = (a) => { FROTA_FILTRO_LIDER = a; frotaRerender(); };
window.frotaBuscar = (t) => { FROTA_BUSCA = t; frotaRerender(); const el = document.getElementById("frota-busca"); if(el){ el.focus(); el.setSelectionRange(t.length,t.length); } };

window.frotaAtualizar = async (id, campo, valor) => {
  const F = frotaCarregar(), v = F.veiculos.find(x=>x.id===id);
  F.dias[FROTA_DATA] = F.dias[FROTA_DATA] || {};
  const r = { ...(F.dias[FROTA_DATA][id] || frotaRegistro(v, FROTA_DATA)) };
  if(campo !== "confirmado") r[campo] = valor;
  if(campo==="atividade" && valor==="oficina" && r.status==="operando") r.status = "manutencao";
  r.confirmado = true; r.em = frotaHora(); r.por = (MEU_EMAIL||"").split("@")[0];
  F.dias[FROTA_DATA][id] = r;
  frotaSalvar(); frotaRerender();
  await frotaGravarStatus([{ id, r }]);
};
window.frotaConfirmarTodos = async () => {
  const lista = frotaDoDia(FROTA_DATA).filter(({v,r})=>!r.confirmado && (FROTA_FILTRO_LIDER==="todas" || r.atividade===FROTA_FILTRO_LIDER || (FROTA_FILTRO_LIDER==="restricao" && frotaRestricao(v.id))));
  if(!lista.length){ toast("Todos já estão confirmados."); return; }
  if(!confirm(`Confirmar ${lista.length} caminhão(ões) sem alteração?`)) return;
  const F = frotaCarregar(); F.dias[FROTA_DATA] = F.dias[FROTA_DATA] || {};
  const hora = frotaHora(), por = (MEU_EMAIL||"").split("@")[0];
  lista.forEach(({v,r})=>{ F.dias[FROTA_DATA][v.id] = { ...r, confirmado:true, em:hora, por }; });
  frotaSalvar(); frotaRerender();
  if(await frotaGravarStatus(lista.map(({v,r})=>({ id:v.id, r })))) toast(`${lista.length} caminhão(ões) confirmados ✓`);
};

window.frotaTextoWhatsApp = () => {
  const itens = frotaDoDia(FROTA_DATA);
  // Numeração segue a ordem em que os caminhões aparecem na mensagem (grupo a grupo, e dentro do
  // grupo pelo número do cadastro) — assim um caminhão que trocou de atividade não fica com número
  // fora de sequência. "continua" = 01..43 na mensagem toda; "grupo" = recomeça em 1 a cada grupo.
  let txt = `OPERAÇÃO DO DIA ${frotaDataBR(FROTA_DATA)}\n`;
  let n = 0;
  FROTA_ATIVIDADES.forEach(a=>{
    const doGrupo = itens.filter(({r})=>r.atividade===a.chave).sort((x,y)=>x.v.ordem-y.v.ordem);
    if(!doGrupo.length) return;
    if(FROTA_NUMERACAO==="grupo") n = 0;
    txt += `\n#${a.label.toUpperCase()}#\n`;
    doGrupo.forEach(({v,r})=>{
      n++;
      const st = r.status!=="operando" && !(a.chave==="oficina" && r.status==="manutencao") ? ` — ${frotaStatus(r.status).label.toUpperCase()}` : "";
      const nome = r.motorista || (a.chave==="oficina" ? "MANUTENÇÃO" : a.chave==="reserva" ? "DISPONÍVEL" : "");
      // restrições ficam só no sistema — não vão para a mensagem do WhatsApp
      txt += `${String(n).padStart(2,"0")} ${v.placa} ${nome}${st}${r.obs ? ` (${r.obs})` : ""}\n`;
    });
  });
  return txt.trim();
};
window.frotaSetNumeracao = (v) => { FROTA_NUMERACAO = v; try{ localStorage.setItem("avance_frota_numeracao", v); }catch(e){} frotaRerender(); };

// ---------- Atualizar o cadastro colando a lista do WhatsApp ----------
// Formato aceito (o mesmo da mensagem dos líderes):
//   #OPERAÇÃO HONDA#
//   01 GCV0C68 JORGE
//   41 ATP3089- MANUTENÇÃO
const FROTA_GRUPO_TEXTO = [[/HONDA/,"honda"],[/DISPON|RESERVA/,"reserva"],[/ENTREGA|COLETA/,"entregas"],[/MANOBRA/,"manobra"],[/PORTO/,"porto"],[/OFICINA|MANUT/,"oficina"]];
let FROTA_LISTA_PREVIA = null;
function frotaNormPlaca(p){
  let s = String(p||"").toUpperCase().replace(/[^A-Z0-9 ]/g,"").trim();
  if(s.replace(/\s/g,"") === "TUGMASTER") return "TUG MASTER";
  s = s.replace(/\s/g,"");
  // Placa (antiga ou Mercosul) sempre tem número na 4ª posição: "GCVOC74" → "GCV0C74"
  if(s.length===7 && s[3]==="O") s = s.slice(0,3) + "0" + s.slice(4);
  return s;
}
function frotaLerListaTexto(txt){
  const itens = []; let grupo = null; const ignoradas = [];
  txt.split(/\r?\n/).forEach(linha=>{
    const l = linha.trim(); if(!l) return;
    if(l.startsWith("#")){
      const g = FROTA_GRUPO_TEXTO.find(([re])=>re.test(l.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g,"")));
      grupo = g ? g[1] : null; if(!g) ignoradas.push(l); return;
    }
    const m = l.match(/^(\d{1,3})\s*[-.)]?\s+(TUG\s*MASTER|[A-Z0-9]{3}-?\s?[A-Z0-9]{4}|[A-Z0-9]{4,8})\s*-?\s*(.*)$/i);
    if(!m || !grupo){ if(!/^OPERA[ÇC][ÃA]O DO DIA/i.test(l)) ignoradas.push(l); return; }
    let nome = m[3].replace(/^[-–\s]+/,"").trim().toUpperCase();
    if(/^(DISPON[IÍ]VEL|MANUTEN[ÇC][ÃA]O)$/.test(nome)) nome = "";
    itens.push({ ordem:parseInt(m[1],10), placa:frotaNormPlaca(m[2]), motorista:nome, atividade:grupo });
  });
  return { itens, ignoradas };
}
window.frotaPreviaLista = () => {
  const txt = document.getElementById("frota-lista-txt")?.value || "";
  const { itens, ignoradas } = frotaLerListaTexto(txt);
  if(!itens.length){ toast("Não reconheci nenhum caminhão. Confira se a lista tem os títulos (#OPERAÇÃO HONDA#...) e as linhas 'número placa motorista'."); return; }
  const atuais = frotaVeiculosOrdenados();
  const usados = new Set();
  const linhas = itens.map(it=>{
    const v = atuais.find(x=>!usados.has(x.id) && frotaNormPlaca(x.placa)===it.placa);
    if(v) usados.add(v.id);
    const muda = v ? [v.ordem!==it.ordem && `nº ${v.ordem}→${it.ordem}`, (v.motorista||"")!==it.motorista && `motorista ${v.motorista||"—"}→${it.motorista||"—"}`,
      v.atividadePadrao!==it.atividade && `${frotaAtiv(v.atividadePadrao).label}→${frotaAtiv(it.atividade).label}`, v.placa!==it.placa && `placa ${v.placa}→${it.placa}`].filter(Boolean) : [];
    return { ...it, v, tipo: !v ? "novo" : muda.length ? "alterado" : "igual", muda };
  });
  const remover = atuais.filter(v=>!usados.has(v.id));
  const dupl = itens.map(i=>i.placa).filter((p,i,a)=>a.indexOf(p)!==i);
  FROTA_LISTA_PREVIA = { linhas, remover, ignoradas, dupl };
  frotaRerender();
};
window.frotaCancelarLista = () => { FROTA_LISTA_PREVIA = null; frotaRerender(); };
window.frotaAplicarLista = async () => {
  const P = FROTA_LISTA_PREVIA; if(!P) return;
  if(P.remover.length && !confirm(`${P.remover.length} caminhão(ões) que não estão na lista serão REMOVIDOS do cadastro (com o histórico deles):\n\n${P.remover.map(v=>`${v.ordem} ${v.placa} ${v.motorista||""}`).join("\n")}\n\nContinuar?`)) return;
  const F = frotaCarregar();
  try{
    const idPorLinha = [];
    for(const l of P.linhas){
      const reg = { ordem:l.ordem, placa:l.placa, motorista:l.motorista, atividadePadrao:l.atividade, obsPadrao: l.v ? l.v.obsPadrao : "" };
      if(FROTA_DB){
        if(l.v){ const { error } = await sb.from("frota_veiculos").update(frotaVeiculoParaBanco(reg)).eq("id", l.v.id); if(error) throw error; idPorLinha.push(l.v.id); }
        else { const { data, error } = await sb.from("frota_veiculos").insert(frotaVeiculoParaBanco(reg)).select().single(); if(error) throw error; idPorLinha.push(data.id); }
      } else {
        if(l.v){ Object.assign(l.v, reg); idPorLinha.push(l.v.id); }
        else { const id = osNovoId(); F.veiculos.push({ id, ...reg }); idPorLinha.push(id); }
      }
    }
    for(const v of P.remover){
      if(FROTA_DB){ const { error } = await sb.from("frota_veiculos").delete().eq("id", v.id); if(error) throw error; }
      else F.veiculos = F.veiculos.filter(x=>x.id!==v.id);
    }
    // A lista também vale como o status do dia selecionado (atividade e motorista de cada caminhão)
    const regs = P.linhas.map((l,i)=>{
      const ant = F.dias[FROTA_DATA] && F.dias[FROTA_DATA][idPorLinha[i]];
      const status = l.atividade==="oficina" ? "manutencao" : (ant && ant.atividade===l.atividade && ant.status!=="manutencao" ? ant.status : "operando");
      return { id:idPorLinha[i], r:{ atividade:l.atividade, motorista:l.motorista, status, obs: ant ? ant.obs : "" } };
    });
    if(FROTA_DB){ await frotaGravarStatus(regs); }
    else { F.dias[FROTA_DATA] = F.dias[FROTA_DATA] || {}; regs.forEach(({id,r})=>{ F.dias[FROTA_DATA][id] = { ...r, confirmado:true, em:frotaHora(), por:(MEU_EMAIL||"").split("@")[0] }; }); frotaSalvar(); }
    FROTA_LISTA_PREVIA = null;
    toast(`✓ Cadastro atualizado: ${P.linhas.length} caminhões`);
    if(FROTA_DB) await frotaBuscarDb(); else frotaRerender();
  }catch(e){ toast("⚠ Não consegui atualizar: " + (e.message||e)); if(FROTA_DB) frotaBuscarDb(); }
};

window.frotaCopiarWhatsApp = async () => {
  const txt = frotaTextoWhatsApp();
  try{ await navigator.clipboard.writeText(txt); toast("Texto copiado ✓ — é só colar no WhatsApp"); }
  catch(e){ const ta = document.getElementById("frota-wpp"); if(ta){ ta.style.display="block"; ta.select(); } toast("Selecione o texto abaixo e copie (Ctrl+C)."); }
};

function frotaVeiculoParaBanco(v){
  return { ordem:v.ordem, placa:v.placa, motorista:v.motorista||null, atividade_padrao:v.atividadePadrao, obs:v.obsPadrao||null };
}
window.frotaAddVeiculo = async () => {
  const placa = osCampo("frota-novo-placa").toUpperCase().replace(/[^A-Z0-9 ]/g,""), motorista = osCampo("frota-novo-mot").toUpperCase(), ativ = osCampo("frota-novo-ativ");
  if(!placa){ toast("Informe a placa."); return; }
  const F = frotaCarregar();
  const v = { id:osNovoId(), ordem:Math.max(0,...F.veiculos.map(v=>v.ordem))+1, placa, motorista, atividadePadrao:ativ||"reserva", obsPadrao:"" };
  if(FROTA_DB){
    const { error } = await sb.from("frota_veiculos").insert(frotaVeiculoParaBanco(v));
    if(error){ toast("⚠ Não salvou: " + error.message); return; }
    await frotaBuscarDb();
  } else { F.veiculos.push(v); frotaSalvar(); frotaRerender(); }
  toast(`${placa} cadastrado ✓`);
};
window.frotaEditarCadastro = async (id, campo, valor) => {
  const v = frotaCarregar().veiculos.find(x=>x.id===id);
  v[campo] = campo==="ordem" ? (parseInt(valor,10)||v.ordem)
           : campo==="placa" ? valor.toUpperCase().replace(/[^A-Z0-9 ]/g,"")
           : campo==="motorista" ? valor.toUpperCase() : valor;
  if(FROTA_DB){
    const { error } = await sb.from("frota_veiculos").update(frotaVeiculoParaBanco(v)).eq("id", id);
    if(error){ toast("⚠ Não salvou: " + error.message); }
    await frotaBuscarDb();
  } else { frotaSalvar(); frotaRerender(); }
};
window.frotaRemoverVeiculo = async (id) => {
  const F = frotaCarregar(), v = F.veiculos.find(x=>x.id===id);
  if(!confirm(`Remover ${v.placa} da frota? O histórico de status dele também é apagado.`)) return;
  if(FROTA_DB){
    const { error } = await sb.from("frota_veiculos").delete().eq("id", id);
    if(error){ toast("⚠ Não removeu: " + error.message); return; }
    await frotaBuscarDb();
  } else { F.veiculos = F.veiculos.filter(x=>x.id!==id); frotaSalvar(); frotaRerender(); }
};
// Dados lançados na versão de teste (antes do banco) ficaram no localStorage deste navegador.
// Isso lê esses dados e envia para o banco: atualiza/insere o cadastro (casando pelo número de
// ordem) e grava o status de cada dia lançado, sem apagar nada do que já estiver no banco.
function frotaTesteLocal(){
  try{
    const raw = localStorage.getItem(FROTA_KEY); if(!raw) return null;
    const d = JSON.parse(raw);
    if(!d || !Array.isArray(d.veiculos) || !d.veiculos.length) return null;
    const lanc = Object.values(d.dias||{}).reduce((n,dia)=>n+Object.keys(dia).length, 0);
    if(d.migradoEm) return null;
    return { d, lanc, dias:Object.keys(d.dias||{}).sort() };
  }catch(e){ return null; }
}
window.frotaRecuperarTeste = async () => {
  const t = frotaTesteLocal(); if(!t || !FROTA_DB) return;
  if(!confirm(`Enviar para o banco os dados do teste deste navegador?\n\n• ${t.d.veiculos.length} caminhões (com as placas e motoristas que você ajustou)\n• ${t.lanc} lançamento(s) de status${t.dias.length ? ` (${t.dias.map(frotaDataBR).join(", ")})` : ""}\n\nNada do que já está no banco é apagado.`)) return;
  try{
    const { data:atuais, error:e1 } = await sb.from("frota_veiculos").select("*");
    if(e1) throw e1;
    const porOrdem = Object.fromEntries(atuais.map(v=>[v.ordem, v]));
    const mapaId = {};
    for(const v of t.d.veiculos){
      const linha = { ordem:v.ordem, placa:v.placa, motorista:v.motorista||null, atividade_padrao:(v.atividadePadrao||"reserva").toLowerCase(),
        obs:(v.obsPadrao || (t.d.modelo && t.d.modelo[v.id] && t.d.modelo[v.id].obs) || null) };
      const existente = porOrdem[v.ordem];
      if(existente){
        const { error } = await sb.from("frota_veiculos").update(linha).eq("id", existente.id);
        if(error) throw error;
        mapaId[v.id] = existente.id;
      } else {
        const { data, error } = await sb.from("frota_veiculos").insert(linha).select().single();
        if(error) throw error;
        mapaId[v.id] = data.id;
      }
    }
    const linhas = [];
    Object.entries(t.d.dias||{}).forEach(([data, regs])=>Object.entries(regs).forEach(([idLocal, r])=>{
      if(!mapaId[idLocal] || !r.confirmado) return;
      linhas.push({ data, veiculo_id:mapaId[idLocal], atividade:r.atividade, motorista:r.motorista||null, status:r.status, obs:r.obs||null,
        atualizado_por:MEU_EMAIL || "teste local", atualizado_em:new Date(`${data}T${(r.em||"08:00")}:00`).toISOString() });
    }));
    for(let i=0;i<linhas.length;i+=200){
      const { error } = await sb.from("frota_status").upsert(linhas.slice(i,i+200), { onConflict:"data,veiculo_id" });
      if(error) throw error;
    }
    t.d.migradoEm = new Date().toISOString();
    try{ localStorage.setItem(FROTA_KEY, JSON.stringify(t.d)); }catch(e){}
    toast(`✓ ${t.d.veiculos.length} caminhões e ${linhas.length} lançamento(s) enviados para o banco`);
    await frotaBuscarDb();
  }catch(e){ toast("⚠ Não consegui enviar: " + (e.message||e)); }
};

window.frotaCarregarListaInicial = async () => {
  if(!confirm("Cadastrar os 42 caminhões da lista inicial (mensagem de 06/10/26)?")) return;
  if(FROTA_DB){
    const { error } = await sb.from("frota_veiculos").insert(frotaListaInicial().map(frotaVeiculoParaBanco));
    if(error){ toast("⚠ Não salvou: " + error.message); return; }
    await frotaBuscarDb();
  } else { FROTA = { veiculos:frotaListaInicial(), dias:{} }; frotaSalvar(); frotaRerender(); }
  toast("Caminhões cadastrados ✓");
};

function frotaPainel(itens){
  const total = itens.length, confirmados = itens.filter(i=>i.r.confirmado).length;
  const porStatus = FROTA_STATUS.map(s=>({ ...s, qtd:itens.filter(i=>i.r.status===s.chave).length }));
  const sel = FROTA_ATIV_SEL ? itens.filter(i=>i.r.atividade===FROTA_ATIV_SEL) : [];
  const nRest = itens.filter(i=>frotaRestricao(i.v.id)).length;
  return `
    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Caminhões na frota</div><div class="val">${total}</div></div>
      ${porStatus.map(s=>`<div class="kpi"><div class="lbl">${s.label}</div><div class="val" style="color:var(--${s.badge==="green"?"green":s.badge==="amber"?"amber":s.badge==="red"?"red":"ink-soft"});">${s.qtd}</div><div class="delta flat">${total?(s.qtd/total*100).toFixed(0):0}% da frota</div></div>`).join("")}
      <div class="kpi"><div class="lbl">⚠️ Com restrição</div><div class="val" style="color:var(--${nRest?"amber":"green"});">${nRest}</div><div class="delta flat">${nRest ? "pendência(s) em aberto" : "nenhuma pendência"}</div></div>
      <div class="kpi"><div class="lbl">Confirmados pelos líderes</div><div class="val" style="color:var(--${confirmados===total?"green":"amber"});">${confirmados}/${total}</div><div class="delta flat">${confirmados===total?"todos atualizados":`${total-confirmados} pendente(s)`}</div></div>
    </div>
    <div class="panel" style="margin-bottom:16px;">
      <h3>Atividades do dia</h3>
      <div class="hint">Clique numa atividade para ver os caminhões.</div>
      <div class="frota-ativs">
        ${FROTA_ATIVIDADES.map(a=>{
          const doGrupo = itens.filter(i=>i.r.atividade===a.chave);
          const alerta = doGrupo.filter(i=>["parado","semmot"].includes(i.r.status)).length;
          const comRest = doGrupo.filter(i=>frotaRestricao(i.v.id)).length;
          return `<button class="frota-ativ ${FROTA_ATIV_SEL===a.chave?"sel":""}" style="--c:${a.cor};" onclick="frotaSelAtiv('${a.chave}')">
            <span class="frota-ativ-lbl">${a.label}</span>
            <span class="frota-ativ-qtd">${doGrupo.length}</span>
            <span class="frota-ativ-sub">${doGrupo.length ? `${(doGrupo.length/total*100).toFixed(0)}% da frota` : "nenhum"}${alerta ? ` · <b style="color:var(--red);">${alerta} parado(s)</b>` : ""}</span>
            ${comRest ? `<span class="frota-ativ-sub"><b style="color:#B86E00;">⚠️ ${comRest} com restrição</b></span>` : ""}
          </button>`;
        }).join("")}
      </div>
      ${FROTA_ATIV_SEL ? `
      <div class="os-sub">
        <h4 style="font-size:14px; margin-bottom:8px;">${frotaAtiv(FROTA_ATIV_SEL).label} — ${sel.length} caminhão(ões)</h4>
        ${sel.length ? `<table>
          <thead><tr><th>#</th><th>Placa</th><th>Motorista</th><th>Status</th><th>Restrição</th><th>Observação</th><th>Atualizado</th></tr></thead>
          <tbody>${sel.map(({v,r})=>`<tr>
            <td>${String(v.ordem).padStart(2,"0")}</td><td><b>${osEsc(v.placa)}</b></td><td>${osEsc(r.motorista)||"—"}</td>
            <td><span class="badge ${frotaStatus(r.status).badge}">${frotaStatus(r.status).label}</span></td>
            <td>${(()=>{ const x = frotaRestricao(v.id); return x ? `<b style="color:#B86E00;">⚠️ ${osEsc(x.descricao)}</b>${x.temFoto ? ` <button class="os-link" onclick="frotaRestVerFoto('${x.id}')">📷</button>` : ""}` : "—"; })()}</td>
            <td>${osEsc(r.obs)||"—"}</td>
            <td>${r.confirmado ? `✓ ${r.em||""}${r.por ? ` · ${osEsc(r.por)}` : ""}` : `<span class="badge gray">não confirmado</span>`}</td>
          </tr>`).join("")}</tbody></table>` : `<div class="hint">Nenhum caminhão nessa atividade hoje.</div>`}
      </div>` : ""}
    </div>
    ${frotaPendenciasHTML(itens)}
    <div class="panel" style="margin-bottom:16px;">
      <h3>Atividades por dia</h3>
      <div class="hint">Caminhões em cada atividade, dia a dia (últimos dias com lançamento). Clique numa coluna para abrir aquele dia.</div>
      <div class="chart-wrap" style="height:340px;"><canvas id="ch-frota-diario"></canvas></div>
    </div>
    <div class="panel" style="margin-bottom:16px;">
      <h3>Mensagem do dia para o WhatsApp</h3>
      <div class="hint">Gerada automaticamente no mesmo formato que você usa hoje, na ordem dos grupos e com a numeração em sequência.</div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
        <button class="entry-submit" style="margin-top:0;" onclick="frotaCopiarWhatsApp()">📋 Copiar texto para o WhatsApp</button>
        <span class="hint" style="margin:0;">Numeração:</span>
        <button class="sub-tab-btn ${FROTA_NUMERACAO==="continua"?"active":""}" onclick="frotaSetNumeracao('continua')">01 a ${itens.length} seguida</button>
        <button class="sub-tab-btn ${FROTA_NUMERACAO==="grupo"?"active":""}" onclick="frotaSetNumeracao('grupo')">recomeça em cada grupo</button>
      </div>
      <textarea id="frota-wpp" readonly class="frota-wpp">${osEsc(frotaTextoWhatsApp())}</textarea>
    </div>`;
}

function frotaLider(itens){
  const busca = FROTA_BUSCA.trim().toUpperCase();
  const filtrados = itens.filter(({v,r})=>(FROTA_FILTRO_LIDER==="todas" || r.atividade===FROTA_FILTRO_LIDER || (FROTA_FILTRO_LIDER==="restricao" && frotaRestricao(v.id)))
    && (!busca || v.placa.includes(busca) || (r.motorista||"").toUpperCase().includes(busca)));
  const pend = filtrados.filter(i=>!i.r.confirmado).length;
  const motoristas = [...new Set(frotaCarregar().veiculos.map(v=>v.motorista).filter(Boolean))].sort();
  return `
    <div class="panel" style="margin-bottom:12px;">
      <div class="frota-filtros">
        <button class="sub-tab-btn ${FROTA_FILTRO_LIDER==="todas"?"active":""}" onclick="frotaFiltroLider('todas')">Todas (${itens.length})</button>
        ${FROTA_ATIVIDADES.map(a=>`<button class="sub-tab-btn ${FROTA_FILTRO_LIDER===a.chave?"active":""}" onclick="frotaFiltroLider('${a.chave}')">${a.label} (${itens.filter(i=>i.r.atividade===a.chave).length})</button>`).join("")}
        ${(()=>{ const n = itens.filter(i=>frotaRestricao(i.v.id)).length; return n ? `<button class="sub-tab-btn ${FROTA_FILTRO_LIDER==="restricao"?"active":""}" onclick="frotaFiltroLider('restricao')">⚠️ Com restrição (${n})</button>` : ""; })()}
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-top:10px;" class="os-form">
        <input id="frota-busca" placeholder="🔎 Buscar placa ou motorista" value="${osEsc(FROTA_BUSCA)}" oninput="frotaBuscar(this.value)" style="flex:1; min-width:200px;">
        <button class="os-btn green" onclick="frotaConfirmarTodos()">✓ Confirmar os ${pend} sem alteração</button>
      </div>
    </div>
    <datalist id="frota-motoristas">${motoristas.map(m=>`<option value="${osEsc(m)}">`).join("")}</datalist>
    <div class="frota-cards">
      ${filtrados.map(({v,r})=>{
        const a = frotaAtiv(r.atividade);
        return `<div class="frota-card ${r.confirmado?"ok":""}" style="--c:${a.cor};">
          <div class="frota-card-top">
            <span class="frota-num">${String(v.ordem).padStart(2,"0")}</span>
            <span class="frota-placa">${osEsc(v.placa)}</span>
            ${r.confirmado ? `<span class="badge green">✓ ${r.em||""}</span>` : `<button class="os-btn sm" onclick="frotaAtualizar('${v.id}','confirmado',true)">Confirmar</button>`}
          </div>
          <div class="os-form">
            <label>Motorista<input list="frota-motoristas" value="${osEsc(r.motorista)}" onchange="frotaAtualizar('${v.id}','motorista',this.value.toUpperCase())"></label>
            <label>Atividade<select onchange="frotaAtualizar('${v.id}','atividade',this.value)">
              ${FROTA_ATIVIDADES.map(x=>`<option value="${x.chave}" ${x.chave===r.atividade?"selected":""}>${x.label}</option>`).join("")}
            </select></label>
          </div>
          <div class="frota-status">
            ${FROTA_STATUS.map(s=>`<button class="frota-st ${r.status===s.chave?"sel "+s.badge:""}" onclick="frotaAtualizar('${v.id}','status','${s.chave}')">${s.label}</button>`).join("")}
          </div>
          ${frotaRestCardHTML(v)}
          <div class="os-form"><input placeholder="Observação (opcional)" value="${osEsc(r.obs)}" onchange="frotaAtualizar('${v.id}','obs',this.value)"></div>
        </div>`;
      }).join("") || `<div class="empty-state"><p>Nenhum caminhão encontrado.</p></div>`}
    </div>`;
}

function frotaCadastro(){
  const veiculos = frotaVeiculosOrdenados();
  const cont = {}; veiculos.forEach(v=>{ cont[v.placa] = (cont[v.placa]||0)+1; });
  const placaSuspeita = (p) => cont[p]>1 ? "placa repetida" : (p.length!==7 && p!=="TUG MASTER") ? "placa incompleta" : p.length===7 && p[3]==="O" ? "letra O no lugar do zero?" : "";
  const problemas = veiculos.filter(v=>placaSuspeita(v.placa)).length;
  const P = FROTA_LISTA_PREVIA;
  const tipoBadge = { novo:'<span class="badge green">novo</span>', alterado:'<span class="badge amber">alterado</span>', igual:'<span class="badge gray">sem mudança</span>' };
  const painelLista = `
    <div class="panel" style="margin-bottom:16px;">
      <h3>📋 Atualizar pela lista do WhatsApp</h3>
      <div class="hint">Cole a lista no mesmo formato que os líderes mandam (títulos com # e linhas "número placa motorista"). O sistema mostra o que vai mudar antes de salvar. A lista também vira o status do dia ${frotaDataBR(FROTA_DATA)}.</div>
      ${P ? `
        <div class="os-resumo" style="margin-top:0;">
          <div>Na lista<b>${P.linhas.length}</b><small>caminhões reconhecidos</small></div>
          <div>Novos<b style="color:var(--green);">${P.linhas.filter(l=>l.tipo==="novo").length}</b></div>
          <div>Alterados<b style="color:var(--amber);">${P.linhas.filter(l=>l.tipo==="alterado").length}</b></div>
          <div>Serão removidos<b style="color:var(--red);">${P.remover.length}</b><small>estão no cadastro mas não na lista</small></div>
        </div>
        ${P.dupl.length ? `<div class="os-alerta red">⛔ Placa repetida na lista: <b>${[...new Set(P.dupl)].join(", ")}</b> — confira antes de salvar.</div>` : ""}
        ${P.ignoradas.length ? `<div class="os-alerta amber">⚠️ Linhas que não entendi (ficam de fora): ${P.ignoradas.map(osEsc).join(" · ")}</div>` : ""}
        <div style="overflow-x:auto; margin-top:12px;"><table>
          <thead><tr><th>#</th><th>Placa</th><th>Motorista</th><th>Atividade</th><th>Situação</th><th>O que muda</th></tr></thead>
          <tbody>${P.linhas.map(l=>`<tr><td>${String(l.ordem).padStart(2,"0")}</td><td><b>${osEsc(l.placa)}</b></td><td>${osEsc(l.motorista)||"—"}</td>
            <td>${frotaAtiv(l.atividade).label}</td><td>${tipoBadge[l.tipo]}</td><td class="hint" style="margin:0;">${l.muda.join(" · ")}</td></tr>`).join("")}
            ${P.remover.map(v=>`<tr style="background:var(--red-soft);"><td>${String(v.ordem).padStart(2,"0")}</td><td><b>${osEsc(v.placa)}</b></td><td>${osEsc(v.motorista)||"—"}</td>
            <td>${frotaAtiv(v.atividadePadrao).label}</td><td><span class="badge red">será removido</span></td><td></td></tr>`).join("")}</tbody>
        </table></div>
        <div style="display:flex; gap:8px; margin-top:12px; flex-wrap:wrap;">
          <button class="os-btn green" onclick="frotaAplicarLista()">✓ Salvar cadastro (${P.linhas.length} caminhões)</button>
          <button class="os-btn" onclick="frotaCancelarLista()">Cancelar</button>
        </div>` : `
        <div class="os-form"><textarea id="frota-lista-txt" rows="8" placeholder="#OPERAÇÃO HONDA#&#10;01 GCV0C68 JORGE&#10;02 GCV3D41 MARCOS&#10;..." style="width:100%; box-sizing:border-box; font-family:ui-monospace,Consolas,monospace;"></textarea></div>
        <button class="entry-submit" onclick="frotaPreviaLista()">Ver o que vai mudar</button>`}
    </div>`;
  return painelLista + `
    <div class="panel" style="margin-bottom:16px;">
      <h3>Caminhões cadastrados (${veiculos.length})</h3>
      <div class="hint">Número, placa, motorista fixo e atividade de costume. A atividade do dia é ajustada pelo líder.</div>
      ${problemas ? `<div class="os-alerta amber" style="margin:0 0 12px;">⚠️ ${problemas} placa(s) para conferir — destacadas em amarelo na tabela.</div>` : ""}
      <table class="os-form">
        <thead><tr><th>#</th><th>Placa</th><th>Motorista fixo</th><th>Atividade de costume</th><th></th></tr></thead>
        <tbody>${veiculos.map(v=>{ const s = placaSuspeita(v.placa); return `<tr ${s?'style="background:#FCF1DE;"':""}>
          <td><input value="${v.ordem}" style="width:52px;" onchange="frotaEditarCadastro('${v.id}','ordem',this.value)"></td>
          <td><input value="${osEsc(v.placa)}" style="width:120px; text-transform:uppercase;" onchange="frotaEditarCadastro('${v.id}','placa',this.value)">${s?` <span class="badge amber">${s}</span>`:""}</td>
          <td><input value="${osEsc(v.motorista)}" style="text-transform:uppercase;" onchange="frotaEditarCadastro('${v.id}','motorista',this.value)"></td>
          <td><select onchange="frotaEditarCadastro('${v.id}','atividadePadrao',this.value)">${FROTA_ATIVIDADES.map(a=>`<option value="${a.chave}" ${a.chave===v.atividadePadrao?"selected":""}>${a.label}</option>`).join("")}</select></td>
          <td><button class="os-link" onclick="frotaRemoverVeiculo('${v.id}')">remover</button></td>
        </tr>`; }).join("")}</tbody>
      </table>
      <div class="os-sub os-form">
        <h4>Cadastrar caminhão</h4>
        <div class="os-grid">
          <label>Placa<input id="frota-novo-placa" placeholder="GCV0114" style="text-transform:uppercase;"></label>
          <label>Motorista fixo<input id="frota-novo-mot" style="text-transform:uppercase;"></label>
          <label>Atividade de costume<select id="frota-novo-ativ">${FROTA_ATIVIDADES.map(a=>`<option value="${a.chave}">${a.label}</option>`).join("")}</select></label>
        </div>
        <button class="entry-submit" onclick="frotaAddVeiculo()">+ Cadastrar</button>
      </div>
    </div>`;
}

/* -------------------- STATUS DA FROTA › OFICINA (caminhões parados em manutenção) --------------------
   Controle dos caminhões que estão na oficina: a oficina registra placa, data da parada, observação,
   peças necessárias e valor prévio → a Diretoria aprova (ou reprova) a compra e a execução → a oficina
   inicia e conclui o serviço. Tabela frota_oficina; a aprovação só pode ser dada pelo Diretor (trava no banco). */
let FOF = { lista:[], carregado:false, carregando:false, erro:null, problemas:[], pecas:[], erroCat:null };
const FOF_CATEGORIAS = ["Motor","Elétrica","Freio","Suspensão","Pneus","Ar-condicionado","Cabine / carroceria","Câmbio / embreagem","Outros"];
const FOF_UNIDADES = ["un","par","jogo","kit","litro","metro"];
let FOF_FORM = null;          // registro em edição/criação
let FOF_FILTRO = "abertos";   // abertos | aguardando | aprovado | execucao | concluido | reprovado | todos
const FOF_LOCAL = "avance_frota_oficina_v1";
const FOF_ST = {
  aguardando: { label:"Aguardando aprovação da Diretoria", curto:"Aguardando aprovação", badge:"amber", icone:"⏳" },
  aprovado:   { label:"Aprovado — aguardando execução",   curto:"Aprovado",             badge:"green",  icone:"👍" },
  execucao:   { label:"Em execução",                       curto:"Em execução",          badge:"amber", icone:"🔧" },
  concluido:  { label:"Concluído",                         curto:"Concluído",            badge:"green", icone:"✅" },
  reprovado:  { label:"Reprovado pela Diretoria",          curto:"Reprovado",            badge:"red",   icone:"✖" },
};
function fofStatus(r){ return r.conclusao ? "concluido" : r.inicio ? "execucao" : r.aprovacao==="aprovado" ? "aprovado" : r.aprovacao==="reprovado" ? "reprovado" : "aguardando"; }
const fofAberto = (r) => !["concluido","reprovado"].includes(fofStatus(r));
const fofPodeAprovar = () => !sb || MEU_PAPEL === "diretor";
function fofDiasParado(r){ return r.dataParada ? nfeDias(r.dataParada, r.conclusao || frotaHojeISO()) : null; }
// Data da parada sugerida: primeiro dia seguido (até hoje) em que o caminhão está em manutenção / oficina
function fofParadaSugerida(vid){
  const F = frotaCarregar(); let d = FROTA_DATA, ini = null;
  for(let i = 0; i < 60; i++){ const r = F.dias[d] && F.dias[d][vid]; if(!r) { if(i===0){ d = nfeAddDias(d, -1); continue; } break; }
    if(r.status==="manutencao" || r.atividade==="oficina"){ ini = d; d = nfeAddDias(d, -1); } else break; }
  return ini || FROTA_DATA;
}
async function fofCarregar(){
  FOF.carregando = true;
  if(!sb){ try{ FOF.lista = JSON.parse(localStorage.getItem(FOF_LOCAL)||"[]"); const c = JSON.parse(localStorage.getItem(FOF_LOCAL+"_cat")||"{}"); FOF.problemas = c.problemas||[]; FOF.pecas = c.pecas||[]; }catch(e){ FOF.lista = []; } }
  else {
    const [{ data, error }, pr, pc] = await Promise.all([ sb.from("frota_oficina").select("*").order("data_parada", { ascending:false }),
      sb.from("frota_problemas").select("*").order("descricao"), sb.from("frota_pecas").select("*").order("nome") ]);
    FOF.erroCat = pr.error ? pr.error.message : pc.error ? pc.error.message : null;
    if(!pr.error) FOF.problemas = pr.data.map(x=>({ id:x.id, descricao:x.descricao||"", categoria:x.categoria||"" }));
    if(!pc.error) FOF.pecas = pc.data.map(x=>({ id:x.id, nome:x.nome||"", unidade:x.unidade||"un", custo:x.custo_medio!=null ? Number(x.custo_medio) : null, atualizadoEm:x.atualizado_em||"" }));
    if(error) FOF.erro = error.message;
    else { FOF.erro = null; FOF.lista = data.map(r=>({ id:r.id, veiculoId:r.veiculo_id, placa:r.placa||"", dataParada:r.data_parada||"", obs:r.observacao||"", pecas:r.pecas||"", itens:Array.isArray(r.pecas_itens) ? r.pecas_itens : [],
      valor:r.valor_previo!=null ? Number(r.valor_previo) : null, aprovacao:r.aprovacao||"", aprovadoPor:(r.aprovado_por||"").split("@")[0], aprovadoEm:r.aprovado_em||"", obsDiretoria:r.obs_diretoria||"",
      inicio:r.inicio_execucao||"", conclusao:r.conclusao||"", valorFinal:r.valor_final!=null ? Number(r.valor_final) : null, por:(r.criado_por||"").split("@")[0] })); }
  }
  FOF.carregando = false; FOF.carregado = true; frotaRerenderSeguro();
}
function fofGarantirCarga(){ if(!FOF.carregado && !FOF.carregando){ FOF.carregando = true; setTimeout(()=>fofCarregar(), 0); } }
function fofSalvarLocal(){ if(!sb) try{ localStorage.setItem(FOF_LOCAL, JSON.stringify(FOF.lista)); localStorage.setItem(FOF_LOCAL+"_cat", JSON.stringify({ problemas:FOF.problemas, pecas:FOF.pecas })); }catch(e){} }
// Peças do registro: lista do cadastro (com quantidade e custo) + texto livre
const fofTotalItens = (itens) => sumArr((itens||[]).map(i=>(Number(i.qtd)||0)*(Number(i.custo)||0)));
function fofPecasTexto(r){ return [...(r.itens||[]).map(i=>`${String(i.qtd).replace(".", ",")} ${i.un||"un"} · ${i.nome}`), ...(r.pecas ? [r.pecas] : [])].join("\n"); }
async function fofGravar(r, campos){
  if(sb){ const { error } = await sb.from("frota_oficina").update({ ...campos, atualizado_por:MEU_EMAIL, atualizado_em:new Date().toISOString() }).eq("id", r.id);
    if(error){ toast(/diretoria/i.test(error.message) ? "⚠ A aprovação é feita pela Diretoria." : /frota_oficina/i.test(error.message) ? "⚠ Falta rodar o SQL da Oficina no Supabase." : "⚠ Não salvou: " + error.message); return false; } }
  fofSalvarLocal(); return true;
}

window.fofNovo = (vid) => {
  const v = vid ? frotaCarregar().veiculos.find(x=>x.id===vid) : null, reg = v ? frotaRegistro(v, FROTA_DATA) : null;
  FOF_FORM = { id:null, veiculoId:v ? v.id : "", placa:v ? v.placa : "", dataParada:v ? fofParadaSugerida(v.id) : FROTA_DATA, obs:reg ? reg.obs||"" : "", pecas:"", valor:null, itens:[], valorManual:false };
  frotaRerender(); setTimeout(()=>document.getElementById("fof-form")?.scrollIntoView({ behavior:"smooth", block:"start" }), 60);
};
// guarda no estado o que já foi digitado (o formulário é redesenhado ao incluir/tirar peças)
function fofLerForm(){ const f = FOF_FORM; if(!f) return; const g = (id) => document.getElementById(id);
  if(g("fof-veic")) f.veiculoId = g("fof-veic").value; if(g("fof-data")) f.dataParada = g("fof-data").value; if(g("fof-obs")) f.obs = g("fof-obs").value;
  if(g("fof-pecas")) f.pecas = g("fof-pecas").value; if(g("fof-valor")) f.valor = osNum("fof-valor") || null; }
function fofRecalcular(){ const f = FOF_FORM; if(f && !f.valorManual && f.itens.length) f.valor = Math.round(fofTotalItens(f.itens)*100)/100; }
window.fofAddItem = () => {
  fofLerForm(); const f = FOF_FORM; if(!f) return;
  const txt = (document.getElementById("fof-it-peca")?.value || "").trim(); if(!txt){ toast("Escolha a peça."); return; }
  const nome = txt.split(" — ")[0].trim(), cat = FOF.pecas.find(x=>x.nome.toUpperCase()===nome.toUpperCase());
  const qtd = parseFloat(String(document.getElementById("fof-it-qtd")?.value||"1").replace(",", ".")) || 1;
  if(!cat && !confirm(`"${nome}" não está no cadastro de peças. Incluir mesmo assim, sem custo médio?`)) return;
  const ja = cat && f.itens.find(i=>i.pecaId===cat.id);
  if(ja) ja.qtd = (Number(ja.qtd)||0) + qtd; else f.itens.push({ pecaId:cat ? cat.id : null, nome:cat ? cat.nome : nome.toUpperCase(), un:cat ? cat.unidade : "un", qtd, custo:cat ? cat.custo : null });
  fofRecalcular(); frotaRerender(); setTimeout(()=>document.getElementById("fof-it-peca")?.focus(), 30);
};
window.fofQtdItem = (i, v) => { fofLerForm(); const n = parseFloat(String(v).replace(",", ".")); if(n > 0 && FOF_FORM){ FOF_FORM.itens[i].qtd = n; fofRecalcular(); frotaRerender(); } };
window.fofTirarItem = (i) => { fofLerForm(); if(!FOF_FORM) return; FOF_FORM.itens.splice(i, 1); fofRecalcular(); frotaRerender(); };
window.fofValorManual = () => { if(FOF_FORM) FOF_FORM.valorManual = true; };
window.fofUsarTotal = () => { fofLerForm(); if(!FOF_FORM) return; FOF_FORM.valorManual = false; FOF_FORM.valor = Math.round(fofTotalItens(FOF_FORM.itens)*100)/100; frotaRerender(); };
window.fofEditar = (id) => { const r = FOF.lista.find(x=>x.id===id); if(!r) return; FOF_FORM = { ...r, itens:(r.itens||[]).map(i=>({ ...i })), valorManual:true }; frotaRerender(); setTimeout(()=>document.getElementById("fof-form")?.scrollIntoView({ behavior:"smooth", block:"start" }), 60); };
window.fofCancelar = () => { FOF_FORM = null; frotaRerender(); };
window.fofSalvar = async () => {
  const f = FOF_FORM; if(!f) return;
  const g = (id) => document.getElementById(id)?.value || "";
  const vid = g("fof-veic"), v = frotaCarregar().veiculos.find(x=>x.id===vid);
  const itens = (f.itens||[]).map(i=>({ pecaId:i.pecaId||null, nome:i.nome, un:i.un||"un", qtd:Number(i.qtd)||0, custo:i.custo!=null ? Number(i.custo) : null }));
  const reg = { veiculo_id:v ? v.id : null, placa:v ? v.placa : f.placa, data_parada:g("fof-data") || null, observacao:g("fof-obs").trim() || null, pecas:g("fof-pecas").trim() || null,
    pecas_itens:itens, valor_previo:osNum("fof-valor") || null };
  if(!reg.placa){ toast("Escolha o caminhão."); return; }
  if(!reg.data_parada){ toast("Informe a data da parada."); return; }
  if(!reg.pecas && !reg.observacao && !itens.length){ toast("Descreva o problema ou as peças."); return; }
  const antigo = f.id ? FOF.lista.find(x=>x.id===f.id) || f : f;
  const mudouOrcamento = f.id && (antigo.pecas!==(reg.pecas||"") || JSON.stringify(antigo.itens||[])!==JSON.stringify(itens) || (antigo.valor||null)!==(reg.valor_previo||null));
  const voltarAprovacao = f.id && f.aprovacao && !f.inicio && mudouOrcamento;   // mudou peças/valor depois de decidido → volta para a Diretoria
  if(voltarAprovacao && !confirm("Peças ou valor mudaram. O registro volta para a aprovação da Diretoria. Continuar?")) return;
  const banco = { ...reg, ...(voltarAprovacao ? { aprovacao:null, aprovado_por:null, aprovado_em:null } : {}), atualizado_por:MEU_EMAIL, atualizado_em:new Date().toISOString() };
  let id = f.id;
  if(sb){ const q = id ? sb.from("frota_oficina").update(banco).eq("id", id).select("id").single() : sb.from("frota_oficina").insert({ ...banco, criado_por:MEU_EMAIL }).select("id").single();
    const { data, error } = await q; if(error){ toast(/frota_oficina|pecas_itens/i.test(error.message) ? "⚠ Falta rodar o SQL da Oficina (cadastros) no Supabase." : "⚠ Não salvou: " + error.message); return; } id = data.id; }
  else if(!id) id = osNovoId();
  const local = { ...(FOF.lista.find(x=>x.id===id) || { aprovacao:"", inicio:"", conclusao:"", por:(MEU_EMAIL||"").split("@")[0] }), id, veiculoId:reg.veiculo_id, placa:reg.placa, dataParada:reg.data_parada,
    obs:reg.observacao||"", pecas:reg.pecas||"", itens, valor:reg.valor_previo, ...(voltarAprovacao ? { aprovacao:"", aprovadoPor:"", aprovadoEm:"" } : {}) };
  const k = FOF.lista.findIndex(x=>x.id===id); if(k>=0) FOF.lista[k] = local; else FOF.lista.unshift(local);
  fofSalvarLocal(); FOF_FORM = null; toast(f.id ? "Registro atualizado ✓" : `${local.placa} registrado ✓ — aguardando aprovação da Diretoria`); frotaRerender();
};
window.fofAprovar = async (id, ok) => {
  const r = FOF.lista.find(x=>x.id===id); if(!r) return;
  if(!fofPodeAprovar()){ toast("A aprovação é feita pela Diretoria."); return; }
  let motivo = "";
  if(ok){ if(!confirm(`Aprovar a compra e a execução do serviço do ${r.placa}${r.valor ? ` (valor prévio ${fmtBRL2(r.valor)})` : ""}?`)) return; }
  else { motivo = (prompt(`Motivo da reprovação do ${r.placa}:`) || "").trim(); if(!motivo){ toast("Informe o motivo para reprovar."); return; } }
  const agora = new Date().toISOString();
  if(await fofGravar(r, { aprovacao: ok ? "aprovado" : "reprovado", aprovado_por:MEU_EMAIL, aprovado_em:agora, obs_diretoria: motivo || null })){
    Object.assign(r, { aprovacao: ok ? "aprovado" : "reprovado", aprovadoPor:(MEU_EMAIL||"").split("@")[0], aprovadoEm:agora, obsDiretoria:motivo });
    toast(ok ? `${r.placa} aprovado ✓ — a oficina já pode executar` : `${r.placa} reprovado`); }
  frotaRerender();
};
window.fofDesfazerAprovacao = async (id) => {
  const r = FOF.lista.find(x=>x.id===id); if(!r || !fofPodeAprovar() || !confirm(`Desfazer a decisão da Diretoria sobre o ${r.placa}?`)) return;
  if(await fofGravar(r, { aprovacao:null, aprovado_por:null, aprovado_em:null, obs_diretoria:null })) Object.assign(r, { aprovacao:"", aprovadoPor:"", aprovadoEm:"", obsDiretoria:"" });
  frotaRerender();
};
window.fofIniciar = async (id) => {
  const r = FOF.lista.find(x=>x.id===id); if(!r) return;
  const d = document.getElementById(`fof-dt-${id}`)?.value || frotaHojeISO();
  if(await fofGravar(r, { inicio_execucao:d })){ r.inicio = d; toast(`${r.placa}: execução iniciada ✓`); }
  frotaRerender();
};
window.fofConcluir = async (id) => {
  const r = FOF.lista.find(x=>x.id===id); if(!r) return;
  const d = document.getElementById(`fof-dt-${id}`)?.value || frotaHojeISO(), vf = osNum(`fof-vf-${id}`) || null;
  if(r.inicio && d < r.inicio){ toast("A conclusão está antes do início da execução."); return; }
  if(await fofGravar(r, { conclusao:d, valor_final:vf })){ r.conclusao = d; r.valorFinal = vf; toast(`${r.placa}: serviço concluído ✓ — lembre de voltar o caminhão para a operação no lançamento do dia`); }
  frotaRerender();
};
window.fofVoltarEtapa = async (id) => {
  const r = FOF.lista.find(x=>x.id===id); if(!r) return; const st = fofStatus(r);
  const campos = st==="concluido" ? { conclusao:null, valor_final:null } : st==="execucao" ? { inicio_execucao:null } : null; if(!campos || !confirm("Voltar uma etapa?")) return;
  if(await fofGravar(r, campos)){ if(st==="concluido"){ r.conclusao = ""; r.valorFinal = null; } else r.inicio = ""; }
  frotaRerender();
};
window.fofExcluir = async (id) => {
  const r = FOF.lista.find(x=>x.id===id); if(!r || !confirm(`Excluir o registro de oficina do ${r.placa}?`)) return;
  if(sb){ const { error } = await sb.from("frota_oficina").delete().eq("id", id); if(error){ toast("⚠ Não excluiu: " + error.message); return; } }
  FOF.lista = FOF.lista.filter(x=>x.id!==id); fofSalvarLocal(); frotaRerender();
};
/* ---------- Cadastro de problemas e de peças (custo médio) ---------- */
async function fofCatGravar(tabela, op, campos, id){
  if(!sb) return { id: id || osNovoId() };
  const agora = { atualizado_por:MEU_EMAIL, atualizado_em:new Date().toISOString() };
  const r = op==="insert" ? await sb.from(tabela).insert({ ...campos, ...agora, criado_por:MEU_EMAIL }).select("id").single()
    : op==="update" ? await sb.from(tabela).update({ ...campos, ...agora }).eq("id", id).select("id").single() : await sb.from(tabela).delete().eq("id", id);
  if(r.error){ toast(new RegExp(tabela).test(r.error.message) ? "⚠ Falta rodar o SQL dos cadastros da Oficina no Supabase." : /duplicate|unique/i.test(r.error.message) ? "⚠ Já existe esse item no cadastro." : "⚠ Não salvou: " + r.error.message); return null; }
  return r.data || { id };
}
window.fofProbAdd = async () => {
  const d = (document.getElementById("fof-prob-desc")?.value || "").trim().toUpperCase(), c = document.getElementById("fof-prob-cat")?.value || "Outros";
  if(!d){ toast("Descreva o problema."); return; }
  if(FOF.problemas.some(x=>x.descricao===d)){ toast("Esse problema já está cadastrado."); return; }
  const r = await fofCatGravar("frota_problemas", "insert", { descricao:d, categoria:c }); if(!r) return;
  FOF.problemas.push({ id:r.id, descricao:d, categoria:c }); FOF.problemas.sort((a,b)=>a.descricao.localeCompare(b.descricao, "pt-BR")); fofSalvarLocal(); toast("Problema cadastrado ✓"); frotaRerender();
};
window.fofProbEditar = async (id, campo, v) => { const x = FOF.problemas.find(p=>p.id===id); if(!x) return; const val = campo==="descricao" ? v.trim().toUpperCase() : v; if(!val) return;
  if(await fofCatGravar("frota_problemas", "update", { [campo]:val }, id)){ x[campo] = val; fofSalvarLocal(); toast("Cadastro atualizado ✓"); } };
window.fofProbExcluir = async (id) => { const x = FOF.problemas.find(p=>p.id===id); if(!x || !confirm(`Excluir o problema "${x.descricao}" do cadastro?`)) return;
  if(await fofCatGravar("frota_problemas", "delete", null, id)){ FOF.problemas = FOF.problemas.filter(p=>p.id!==id); fofSalvarLocal(); frotaRerender(); } };
window.fofPecaAdd = async () => {
  const n = (document.getElementById("fof-peca-nome")?.value || "").trim().toUpperCase(), u = document.getElementById("fof-peca-un")?.value || "un", c = osNum("fof-peca-custo") || null;
  if(!n){ toast("Informe o nome da peça."); return; }
  if(FOF.pecas.some(x=>x.nome===n)){ toast("Essa peça já está cadastrada."); return; }
  const r = await fofCatGravar("frota_pecas", "insert", { nome:n, unidade:u, custo_medio:c }); if(!r) return;
  FOF.pecas.push({ id:r.id, nome:n, unidade:u, custo:c, atualizadoEm:new Date().toISOString() }); FOF.pecas.sort((a,b)=>a.nome.localeCompare(b.nome, "pt-BR")); fofSalvarLocal(); toast("Peça cadastrada ✓"); frotaRerender();
};
window.fofPecaEditar = async (id, campo, el) => { const x = FOF.pecas.find(p=>p.id===id); if(!x) return;
  const val = campo==="custo_medio" ? (()=>{ const t = el.value.replace(/[R$\s]/g,""); const n = parseFloat(t.includes(",") ? t.replace(/\./g,"").replace(",",".") : t); return isNaN(n) ? null : n; })() : campo==="nome" ? el.value.trim().toUpperCase() : el.value;
  if(campo==="nome" && !val) return;
  if(await fofCatGravar("frota_pecas", "update", { [campo]:val }, id)){ if(campo==="custo_medio"){ x.custo = val; x.atualizadoEm = new Date().toISOString(); } else if(campo==="nome") x.nome = val; else x.unidade = val; fofSalvarLocal(); toast("Peça atualizada ✓"); } };
window.fofPecaExcluir = async (id) => { const x = FOF.pecas.find(p=>p.id===id); if(!x || !confirm(`Excluir a peça "${x.nome}" do cadastro?`)) return;
  if(await fofCatGravar("frota_pecas", "delete", null, id)){ FOF.pecas = FOF.pecas.filter(p=>p.id!==id); fofSalvarLocal(); frotaRerender(); } };
function fofCadastrosHTML(){
  const usosProb = (d) => FOF.lista.filter(r=>(r.obs||"").toUpperCase().includes(d)).length;
  const usosPeca = (id) => FOF.lista.filter(r=>(r.itens||[]).some(i=>i.pecaId===id)).length;
  const brl = (v) => v!=null ? "R$ " + Number(v).toLocaleString("pt-BR", { minimumFractionDigits:2, maximumFractionDigits:2 }) : "";
  return `${FOF.erroCat ? `<div class="os-alerta amber" style="margin-bottom:16px;">⚠️ Cadastros indisponíveis: ${osEsc(FOF.erroCat)}. Rode o SQL dos cadastros da Oficina no Supabase.</div>` : ""}
  <div class="grid-2 fof-cads">
    <div class="panel">
      <h3 style="margin:0;">🧩 Cadastro de problemas (${FOF.problemas.length})</h3>
      <div class="hint">Os problemas cadastrados aparecem na lista da Observação ao registrar um caminhão.</div>
      <div class="fof-cad-add os-form">
        <input id="fof-prob-desc" placeholder="ex: VAZAMENTO DE ÓLEO NO MOTOR" style="text-transform:uppercase; flex:2; min-width:180px;" onkeydown="if(event.key==='Enter') fofProbAdd()">
        <select id="fof-prob-cat" style="flex:1; min-width:140px;">${FOF_CATEGORIAS.map(c=>`<option>${c}</option>`).join("")}</select>
        <button class="entry-submit" style="margin:0;" onclick="fofProbAdd()">+ Cadastrar</button>
      </div>
      ${FOF.problemas.length ? `<div style="overflow-x:auto; max-height:420px; overflow-y:auto; margin-top:10px;"><table class="nf-tab">
        <thead><tr><th>Problema</th><th>Categoria</th><th class="num">Usos</th><th></th></tr></thead>
        <tbody>${FOF.problemas.map(x=>`<tr>
          <td><input class="fof-cad-in" value="${osEsc(x.descricao)}" onchange="fofProbEditar('${x.id}','descricao',this.value)"></td>
          <td><select class="fof-cad-in" onchange="fofProbEditar('${x.id}','categoria',this.value)">${FOF_CATEGORIAS.map(c=>`<option ${c===x.categoria?"selected":""}>${c}</option>`).join("")}</select></td>
          <td class="num">${usosProb(x.descricao)}</td><td><button class="os-link" onclick="fofProbExcluir('${x.id}')" title="Excluir">🗑️</button></td></tr>`).join("")}</tbody>
      </table></div>` : `<div class="empty-state" style="padding:14px;"><p>Nenhum problema cadastrado ainda.</p></div>`}
    </div>
    <div class="panel">
      <h3 style="margin:0;">🔩 Cadastro de peças — custo médio (${FOF.pecas.length})</h3>
      <div class="hint">Ao registrar um caminhão, escolha as peças e a quantidade: o valor prévio sai do custo médio.</div>
      <div class="fof-cad-add os-form">
        <input id="fof-peca-nome" placeholder="ex: KIT EMBREAGEM" style="text-transform:uppercase; flex:2; min-width:160px;" onkeydown="if(event.key==='Enter') fofPecaAdd()">
        <select id="fof-peca-un" style="width:90px;">${FOF_UNIDADES.map(u=>`<option>${u}</option>`).join("")}</select>
        <input id="fof-peca-custo" placeholder="R$ custo médio" inputmode="numeric" style="width:140px;" oninput="osMascaraBRL(this)" onkeydown="if(event.key==='Enter') fofPecaAdd()">
        <button class="entry-submit" style="margin:0;" onclick="fofPecaAdd()">+ Cadastrar</button>
      </div>
      ${FOF.pecas.length ? `<div style="overflow-x:auto; max-height:420px; overflow-y:auto; margin-top:10px;"><table class="nf-tab">
        <thead><tr><th>Peça</th><th>Un.</th><th class="num">Custo médio</th><th class="num">Usos</th><th></th></tr></thead>
        <tbody>${FOF.pecas.map(x=>`<tr>
          <td><input class="fof-cad-in" value="${osEsc(x.nome)}" onchange="fofPecaEditar('${x.id}','nome',this)"></td>
          <td><select class="fof-cad-in" style="width:76px;" onchange="fofPecaEditar('${x.id}','unidade',this)">${FOF_UNIDADES.map(u=>`<option ${u===x.unidade?"selected":""}>${u}</option>`).join("")}</select></td>
          <td class="num"><input class="fof-cad-in" style="width:120px; text-align:right;" value="${brl(x.custo)}" placeholder="R$ —" inputmode="numeric" oninput="osMascaraBRL(this)" onchange="fofPecaEditar('${x.id}','custo_medio',this)">
            ${x.atualizadoEm ? `<div class="hint" style="margin:0;">atual. ${fmtDataBR(x.atualizadoEm.slice(0,10))}</div>` : ""}</td>
          <td class="num">${usosPeca(x.id)}</td><td><button class="os-link" onclick="fofPecaExcluir('${x.id}')" title="Excluir">🗑️</button></td></tr>`).join("")}</tbody>
      </table></div>` : `<div class="empty-state" style="padding:14px;"><p>Nenhuma peça cadastrada ainda.</p></div>`}
    </div>
  </div>`;
}
window.fofFiltro = (f) => { FOF_FILTRO = FOF_FILTRO===f ? "abertos" : f; frotaRerender(); };

function frotaOficina(itens){
  fofGarantirCarga();
  if(FOF.erro) return `<div class="panel"><div class="empty-state" style="padding:24px;"><div class="glyph">⚠️</div><h4>Não foi possível carregar a Oficina</h4><p>${osEsc(FOF.erro)}</p><p>Se falar em tabela inexistente ("frota_oficina"), rode o SQL da Oficina no Supabase.</p></div></div>`;
  if(!FOF.carregado) return `<div class="panel"><div class="empty-state" style="padding:24px;"><p>Carregando...</p></div></div>`;
  const hoje = frotaHojeISO(), mes = hoje.slice(0,7), veics = frotaVeiculosOrdenados();
  const comSt = FOF.lista.map(r=>({ r, st:fofStatus(r) }));
  const cont = {}; Object.keys(FOF_ST).forEach(k=>cont[k] = comSt.filter(x=>x.st===k).length);
  const valorDe = (k) => sumArr(comSt.filter(x=>x.st===k).map(x=>x.r.valor||0));
  const abertos = comSt.filter(x=>fofAberto(x.r)), conclMes = comSt.filter(x=>x.st==="concluido" && x.r.conclusao.startsWith(mes));
  const mediaDias = abertos.length ? Math.round(sumArr(abertos.map(x=>fofDiasParado(x.r)||0))/abertos.length) : 0;
  // caminhões que estão em manutenção hoje e ainda não têm registro aberto
  const semRegistro = itens.filter(({v,r})=>(r.status==="manutencao" || r.atividade==="oficina") && !FOF.lista.some(x=>fofAberto(x) && (x.veiculoId===v.id || x.placa===v.placa)));
  const lista = comSt.filter(x=>FOF_FILTRO==="todos" || (FOF_FILTRO==="abertos" ? fofAberto(x.r) : x.st===FOF_FILTRO))
    .sort((a,b)=>Object.keys(FOF_ST).indexOf(a.st)-Object.keys(FOF_ST).indexOf(b.st) || (a.r.dataParada||"").localeCompare(b.r.dataParada||""));
  const f = FOF_FORM;
  return `
    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">⏳ Aguardando aprovação</div><div class="val" style="color:var(--amber);">${cont.aguardando}</div><div class="delta flat">${fmtBRL(valorDe("aguardando"))} em peças/serviços</div></div>
      <div class="kpi"><div class="lbl">👍 Aprovados p/ executar</div><div class="val">${cont.aprovado}</div><div class="delta flat">${fmtBRL(valorDe("aprovado"))}</div></div>
      <div class="kpi"><div class="lbl">🔧 Em execução</div><div class="val">${cont.execucao}</div><div class="delta flat">${fmtBRL(valorDe("execucao"))}</div></div>
      <div class="kpi"><div class="lbl">✅ Concluídos no mês</div><div class="val" style="color:var(--green);">${conclMes.length}</div><div class="delta flat">${fmtBRL(sumArr(conclMes.map(x=>x.r.valorFinal ?? x.r.valor ?? 0)))}</div></div>
      <div class="kpi"><div class="lbl">📅 Dias parados (média)</div><div class="val" style="color:var(--${mediaDias>7?"red":"ink"});">${mediaDias}</div><div class="delta flat">${abertos.length} caminhão(ões) parado(s)</div></div>
    </div>

    ${semRegistro.length ? `<div class="panel fof-sem" style="margin-bottom:16px;">
      <h3 style="margin:0;">🚛 Em manutenção hoje sem registro na Oficina (${semRegistro.length})</h3>
      <div class="hint">Caminhões marcados em manutenção / oficina no lançamento do dia. Clique para registrar peças e valor.</div>
      <div class="fof-chips">${semRegistro.map(({v,r})=>`<button class="fof-chip" onclick="fofNovo('${v.id}')"><b>${osEsc(v.placa)}</b><span>${osEsc(r.obs||"sem observação")}</span><em>+ registrar</em></button>`).join("")}</div>
    </div>` : ""}

    ${f ? `<div class="panel os-form fof-form" id="fof-form" style="margin-bottom:16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
        <h3 style="margin:0;">${f.id ? `✏️ Editar — ${osEsc(f.placa)}` : "🔧 Registrar caminhão na oficina"}</h3><button class="os-btn" onclick="fofCancelar()">Fechar</button>
      </div>
      <div class="nf-grid" style="grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); margin-top:10px;">
        <label>Placa<select id="fof-veic"><option value="">Selecione</option>${veics.map(v=>`<option value="${v.id}" ${v.id===f.veiculoId || (!f.veiculoId && v.placa===f.placa) ? "selected" : ""}>${String(v.ordem).padStart(2,"0")} · ${osEsc(v.placa)}</option>`).join("")}</select></label>
        <label>Data da parada do caminhão<input type="date" id="fof-data" value="${f.dataParada||""}"></label>
        <label>Valor prévio ${(f.itens||[]).length && !f.valorManual ? "<small>(soma das peças)</small>" : ""}<input id="fof-valor" inputmode="numeric" placeholder="R$ 0,00" value="${f.valor ? "R$ " + f.valor.toLocaleString("pt-BR", { minimumFractionDigits:2, maximumFractionDigits:2 }) : ""}" oninput="osMascaraBRL(this); fofValorManual()"></label>
      </div>
      <label>Observação (o problema)<input id="fof-obs" list="fof-probs" value="${osEsc(f.obs||"")}" placeholder="escolha um problema cadastrado ou descreva"></label>
      <datalist id="fof-probs">${FOF.problemas.map(x=>`<option value="${osEsc(x.descricao)}">${osEsc(x.categoria)}</option>`).join("")}</datalist>
      <div class="fof-itens">
        <div class="fof-cad-add os-form" style="margin-top:0;">
          <label style="flex:2; min-width:200px; margin:0;">Peça do cadastro<input id="fof-it-peca" list="fof-pecs" placeholder="${FOF.pecas.length ? "comece a digitar o nome da peça" : "cadastre as peças no quadro abaixo"}" onkeydown="if(event.key==='Enter') fofAddItem()"></label>
          <label style="width:90px; margin:0;">Qtd<input id="fof-it-qtd" value="1" inputmode="decimal" onkeydown="if(event.key==='Enter') fofAddItem()"></label>
          <button class="entry-submit" style="margin:0;" onclick="fofAddItem()">+ Peça</button>
        </div>
        <datalist id="fof-pecs">${FOF.pecas.map(x=>`<option value="${osEsc(x.nome)} — ${x.custo!=null ? fmtBRL2(x.custo) : "sem custo"} / ${x.unidade}">`).join("")}</datalist>
        ${(f.itens||[]).length ? `<table class="nf-tab" style="margin-top:8px;">
          <thead><tr><th>Peça</th><th class="num">Qtd</th><th class="num">Custo médio</th><th class="num">Subtotal</th><th></th></tr></thead>
          <tbody>${f.itens.map((i,k)=>`<tr><td><b>${osEsc(i.nome)}</b></td>
            <td class="num"><input class="bal-num" style="width:64px; text-align:right;" value="${String(i.qtd).replace(".", ",")}" inputmode="decimal" onchange="fofQtdItem(${k}, this.value)"> ${osEsc(i.un||"un")}</td>
            <td class="num">${i.custo!=null ? fmtBRL2(i.custo) : "—"}</td><td class="num"><b>${fmtBRL2((Number(i.qtd)||0)*(Number(i.custo)||0))}</b></td>
            <td><button class="os-link" onclick="fofTirarItem(${k})" title="Tirar">🗑️</button></td></tr>`).join("")}</tbody>
          <tfoot><tr style="font-weight:800; background:var(--paper);"><td colspan="3">Total das peças (custo médio)</td><td class="num">${fmtBRL2(fofTotalItens(f.itens))}</td><td>${f.valorManual ? `<button class="os-link" onclick="fofUsarTotal()" title="Usar este total como valor prévio">usar</button>` : ""}</td></tr></tfoot>
        </table>` : ""}
      </div>
      <label>Outras peças / detalhes (opcional)<textarea id="fof-pecas" rows="2" placeholder="o que não está no cadastro, ex: mão de obra terceirizada...">${osEsc(f.pecas||"")}</textarea></label>
      <button class="entry-submit" onclick="fofSalvar()">${f.id ? "💾 Salvar alterações" : "💾 Registrar e enviar para aprovação"}</button>
    </div>` : ""}

    <div class="panel" style="margin-bottom:16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
        <div><h3 style="margin:0;">🔧 Oficina — caminhões parados</h3>
          <div class="hint">Oficina registra → Diretoria aprova a compra e a execução → oficina executa e conclui.</div></div>
        <button class="entry-submit" style="margin:0;" onclick="fofNovo()">+ Registrar caminhão</button>
      </div>
      <div class="prog-chips" style="margin:10px 0 0;">
        <button class="sub-tab-btn ${FOF_FILTRO==="abertos"?"active":""}" onclick="fofFiltro('abertos')">Em aberto (${abertos.length})</button>
        ${Object.entries(FOF_ST).map(([k,s])=>`<button class="sub-tab-btn ${FOF_FILTRO===k?"active":""}" onclick="fofFiltro('${k}')">${s.icone} ${s.curto} (${cont[k]})</button>`).join("")}
        <button class="sub-tab-btn ${FOF_FILTRO==="todos"?"active":""}" onclick="fofFiltro('todos')">Todos (${FOF.lista.length})</button>
      </div>
      ${lista.length ? `<div style="overflow-x:auto; margin-top:10px;"><table class="nf-tab fof-tab">
        <thead><tr><th>Placa</th><th>Parada</th><th>Observação</th><th>Peças</th><th class="num">Valor prévio</th><th>Situação</th><th>Próxima ação</th><th></th></tr></thead>
        <tbody>${lista.map(({r, st})=>{ const s = FOF_ST[st], dias = fofDiasParado(r), v = veics.find(x=>x.id===r.veiculoId);
          const dt = `<input type="date" id="fof-dt-${r.id}" value="${hoje}" class="nfe-pg">`;
          const acao = st==="aguardando" ? (fofPodeAprovar() ? `<button class="os-btn sm green" onclick="fofAprovar('${r.id}', true)">✅ Aprovar</button> <button class="os-btn sm" onclick="fofAprovar('${r.id}', false)">✖ Reprovar</button>` : `<span class="hint" style="margin:0;">aguardando a Diretoria</span>`)
            : st==="aprovado" ? `${dt} <button class="os-btn sm" onclick="fofIniciar('${r.id}')">▶ Iniciar execução</button>`
            : st==="execucao" ? `${dt} <input id="fof-vf-${r.id}" class="bal-num" style="width:110px;" placeholder="R$ valor final" inputmode="numeric" oninput="osMascaraBRL(this)"> <button class="os-btn sm green" onclick="fofConcluir('${r.id}')">✅ Concluir</button>`
            : st==="reprovado" ? `<span class="hint" style="margin:0;">ajuste e salve para reenviar</span>` : `<span class="hint" style="margin:0;">${r.valorFinal!=null ? `valor final ${fmtBRL2(r.valorFinal)}` : ""}</span>`;
          return `<tr>
            <td><b>${osEsc(r.placa)}</b>${v ? `<div class="hint" style="margin:0;">nº ${String(v.ordem).padStart(2,"0")}</div>` : ""}</td>
            <td style="white-space:nowrap;">${r.dataParada ? fmtDataBR(r.dataParada) : "—"}${dias!=null ? `<div class="hint" style="margin:0; ${dias>7 && st!=="concluido" ? "color:var(--red); font-weight:700;" : ""}">${st==="concluido" ? `ficou ${dias} dia(s)` : `há ${dias} dia(s)`}</div>` : ""}</td>
            <td style="max-width:220px;">${osEsc(r.obs)||"—"}</td>
            <td style="max-width:260px; white-space:pre-line; font-size:12.5px;">${osEsc(fofPecasTexto(r))||"—"}</td>
            <td class="num"><b>${r.valor!=null ? fmtBRL2(r.valor) : "—"}</b></td>
            <td><span class="badge ${s.badge}">${s.icone} ${s.curto}</span>
              ${r.aprovacao ? `<div class="hint" style="margin:2px 0 0;">${r.aprovacao==="aprovado" ? "aprovado" : "reprovado"} por ${osEsc(r.aprovadoPor||"—")}${r.aprovadoEm ? ` · ${fmtDataBR(r.aprovadoEm.slice(0,10))}` : ""}${fofPodeAprovar() && !r.inicio ? ` <button class="os-link" onclick="fofDesfazerAprovacao('${r.id}')">desfazer</button>` : ""}</div>` : ""}
              ${r.obsDiretoria ? `<div class="hint" style="margin:0; color:var(--red);">motivo: ${osEsc(r.obsDiretoria)}</div>` : ""}
              ${r.inicio ? `<div class="hint" style="margin:0;">execução desde ${fmtDataBR(r.inicio)}${r.conclusao ? ` · concluído ${fmtDataBR(r.conclusao)}` : ""}</div>` : ""}</td>
            <td style="white-space:nowrap;">${acao}</td>
            <td style="white-space:nowrap;">${["execucao","concluido"].includes(st) ? `<button class="os-link" onclick="fofVoltarEtapa('${r.id}')" title="Voltar uma etapa">↩</button> ` : ""}<button class="os-link" onclick="fofEditar('${r.id}')" title="Editar">✏️</button> <button class="os-link" onclick="fofExcluir('${r.id}')" title="Excluir">🗑️</button></td>
          </tr>`; }).join("")}</tbody>
        <tfoot><tr style="font-weight:800; background:var(--paper);"><td colspan="4">Total (${lista.length})</td><td class="num">${fmtBRL2(sumArr(lista.map(x=>x.r.valor||0)))}</td><td colspan="3"></td></tr></tfoot>
      </table></div>` : `<div class="empty-state" style="padding:16px;"><p>Nenhum caminhão neste filtro.</p></div>`}
    </div>
    ${fofCadastrosHTML()}`;
}

renderers.frota = () => {
  const F = frotaCarregar();
  if(!frotaPodeCadastrar() && FROTA_ABA==="cadastro") FROTA_ABA = "painel";
  const soOficina = MEU_PAPEL === "frotaoficina";   // perfil Oficina da frota: só a aba Oficina
  if(soOficina) FROTA_ABA = "oficina";
  // O líder abre direto na tela de lançamento
  if(MEU_PAPEL==="lider" && !renderers.frota._abriu){ FROTA_ABA = "lider"; renderers.frota._abriu = true; }
  const itens = frotaDoDia(FROTA_DATA);
  const aba = (k,l) => `<button class="tab-btn ${FROTA_ABA===k?"active":""}" onclick="frotaSetAba('${k}')">${l}</button>`;
  let corpo;
  if(F.carregando) corpo = `<div class="panel"><div class="empty-state" style="padding:24px;"><div class="glyph">⏳</div><p>Carregando a frota...</p></div></div>`;
  else if(F.erro) corpo = `<div class="panel"><div class="empty-state" style="padding:24px;"><div class="glyph">⚠️</div><h4>Não foi possível carregar a frota</h4>
      <p>${osEsc(F.erro)}</p><p>Se o erro falar em tabela inexistente ("frota_veiculos"), rode o SQL da frota no Supabase.</p></div></div>`;
  else if(!F.veiculos.length) corpo = `<div class="panel"><div class="empty-state" style="padding:24px;"><div class="glyph">🚛</div><h4>Nenhum caminhão cadastrado</h4>
      ${frotaPodeCadastrar() ? `<p>Cadastre um por um na aba Caminhões, ou carregue a lista inicial de 42 caminhões.</p>
      <button class="entry-submit" onclick="frotaCarregarListaInicial()">Carregar os 42 caminhões da lista inicial</button>` : `<p>Peça ao diretor para cadastrar os caminhões.</p>`}</div></div>`;
  else corpo = FROTA_ABA==="lider" ? frotaLider(itens) : FROTA_ABA==="cadastro" ? frotaCadastro() : FROTA_ABA==="oficina" ? frotaOficina(itens) : frotaPainel(itens);
  // A recuperação do teste local só aparece com o cadastro do banco VAZIO — com caminhões já
  // cadastrados, enviar os dados antigos deste navegador sobrescreveria a lista atual.
  const teste = FROTA_DB && !F.carregando && !F.erro && MEU_PAPEL==="diretor" && !F.veiculos.length ? frotaTesteLocal() : null;
  if(teste) corpo = `
    <div class="os-alerta amber" style="margin:0 0 16px; display:flex; flex-wrap:wrap; gap:10px; align-items:center; justify-content:space-between;">
      <span>💾 <b>Encontrei os dados do teste salvos neste navegador:</b> ${teste.d.veiculos.length} caminhões e ${teste.lanc} lançamento(s) de status${teste.dias.length ? ` (${teste.dias.map(frotaDataBR).join(", ")})` : ""}.</span>
      <button class="os-btn green" onclick="frotaRecuperarTeste()">Enviar esses dados para o banco</button>
    </div>` + corpo;
  return `
    <div class="page-head">
      <h2>Status da Frota</h2>
      <p>Atividade, motorista e status de cada caminhão no dia — preenchido pelos líderes no tablet</p>
    </div>
    ${FROTA_DB ? `
    <div class="frota-sync-bar">
      <span>🟢 Compartilhado em tempo real — atualiza sozinho a cada 30 segundos · <span id="frota-sync">${F.atualizadoEm ? `atualizado às ${F.atualizadoEm}` : ""}</span></span>
      <button class="os-link" onclick="frotaAtualizarAgora()">↻ atualizar agora</button>
    </div>` : `
    <div class="os-proto"><div><b>🧪 Modo local.</b> Sem banco de dados configurado — os dados ficam só neste navegador.</div></div>`}
    <div class="frota-topo">
      <div class="tabs" style="margin:0;">
        ${soOficina ? "" : aba("painel","📊 Painel do dia") + aba("lider","📝 Lançamento do líder")}${aba("oficina", `🔧 Oficina${(()=>{ fofGarantirCarga(); const n = FOF.lista.filter(r=>fofStatus(r)==="aguardando").length; return n ? ` <span class="fof-n">${n}</span>` : ""; })()}`)}${frotaPodeCadastrar() && !soOficina ? aba("cadastro","🚛 Caminhões") : ""}
      </div>
      <label class="frota-data">Dia <input type="date" value="${FROTA_DATA}" onchange="frotaSetData(this.value)"></label>
    </div>
    ${corpo}`;
};

/* -------------------- PROGRAMAÇÃO DIÁRIA DE ENTREGAS --------------------
   Aba da tela Entregas onde a pessoa do Monitoramento lança, dia a dia, cada entrega programada
   (frota, motorista, cliente, transportadora, horário e NF) e depois marca o que foi realizado.
   Planejado = entregas programadas; Realizado = entregas marcadas como realizadas (inclui extras).
   Tudo fica na tabela entregas_programacao (histórico por dia) e vira a mensagem do WhatsApp. */
const PROG_KEY = "avance_entregas_programacao_v1";
const PROG_DB = !!sb;
const PROG_SERVICOS = ["ENTREGA","COLETA","DESCARGA"];
const PROG_HORARIOS = ["06:00","07:00","08:00","09:00","10:00","11:00","13:00","14:00","15:00","16:00","17:00","18:00"];
const PROG_SUG_CLIENTES = ["BNB","AMAZON INDUSTRIA","THAP","CENTER CARGO","ATACADÃO","SENDAS","NOVA ERA","COSTA BRASIL","ITAM","RUFINO","EBD","CREDIE","CARREFOUR","SUPERMERCADOS DB","ORTOBOM","SEMILLON","DUNORTE","CB COMERCIO","HAVAN","NATUREZA COMERCIO","EMPRESA BRASILEIRA DE DISTRIBUIÇÃO","PETROBRAS","M MOTA COELHO","ARROW","ETERNIT","WAISON","CREDY","MILK 92","AMERICANAS","BEGUR","RCL COMERCIO","BEMOL","AROSUCO","ROCHA E PAIVA","ESTALEIRO SÃO JOÃO","SAINT-GOBAIN","ITARANA","CORREIOS","MARTINS","METALFINO","PIARARA","COEMA"];
const PROG_SUG_TRANSP = ["COMPAR","SUZANO","BRILUX","GOIAS MINAS","ALBRAS","OVER TRUCK","TRANSUL","COOPERCARGA","QUIMICA","CCGL","ITALAC","ARROW","SOLAR","PETONY","BENEVIDES","1500 TRANSPORTES","TAMBAU","NOVA ROCHA","BBT","REAL 94","GIVOVA","ALCOA","HEINEKEN","ITAM","MIRASSOL","TRANSBEN","HILEIA","HNK","HU TRANSPORTES","FB SERVIÇOS","BRASKEN","CONCEITO","CLIK","APOTEOSE","BNB","MILI S/A","SÓ FRUTAS","PQA QUIMICA","P&G","LSL"];
// Motivos de entrega não realizada (vão para a lista e para a mensagem do WhatsApp)
const PROG_MOTIVOS = ["Problema OP Combitrans","Problema OP Avance","Falta de cavalo","Cancelamento do cliente","Falta de motorista","Problema com carga","Outros"];
const PROG_SITUACAO = {
  pendente:      { label:"Pendente",      icone:"⏳", badge:"gray"  },
  realizada:     { label:"Realizada",     icone:"✅", badge:"green" },
  nao_realizada: { label:"Não realizada", icone:"❌", badge:"red"   },
};

let ENT_ABA = "receita";          // receita | prog
let PROG_DIA = frotaHojeISO();
let PROG_MES = PROG_DIA.slice(0,7);
let PROG = { linhas:[], carregando:false, mesCarregado:null, erro:null, veiculos:[] };
let PROG_FORM = { servico:"ENTREGA", horario:"", planejado:true };
let PROG_ASSINATURA = "";

window.setEntAba = (a) => { ENT_ABA = a; navigate("entregas"); };
function progMesesOpcoes(){
  const out = [], d = new Date(); d.setDate(1);
  for(let i=0;i<12;i++){ out.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`); d.setMonth(d.getMonth()-1); }
  if(!out.includes(PROG_MES)) out.push(PROG_MES);
  return out;
}
function progNomeMes(m){ const [a,mm] = m.split("-"); return `${MESES_HE[Number(mm)-1]}/${a.slice(2)}`; }
function progDiaSemana(iso){ return ["domingo","segunda","terça","quarta","quinta","sexta","sábado"][new Date(iso+"T12:00:00").getDay()]; }
function progDoDia(d){ return PROG.linhas.filter(l=>l.data===d).sort((a,b)=>(a.horario||"99").localeCompare(b.horario||"99") || (a.frota||"").localeCompare(b.frota||"")); }

async function progCarregar(silencioso){
  const mes = PROG_MES;
  if(!silencioso){ PROG.carregando = true; }
  if(!PROG_DB){
    try{ PROG.linhas = JSON.parse(localStorage.getItem(PROG_KEY)||"[]"); }catch(e){ PROG.linhas = []; }
    if(!PROG.veiculos.length) PROG.veiculos = frotaVeiculosOrdenados();
    PROG.carregando = false; PROG.mesCarregado = mes; progRerender(); return;
  }
  const ini = `${mes}-01`, fimD = new Date(Number(mes.slice(0,4)), Number(mes.slice(5,7)), 0), fim = `${mes}-${String(fimD.getDate()).padStart(2,"0")}`;
  // também busca os 10 dias antes do mês, para "copiar programação do último dia" funcionar no dia 1
  const antes = new Date(ini+"T12:00:00"); antes.setDate(antes.getDate()-10);
  const [lin, vei, st] = await Promise.all([
    sb.from("entregas_programacao").select("*").gte("data", antes.toISOString().slice(0,10)).lte("data", fim),
    sb.from("frota_veiculos").select("id,ordem,placa,motorista").order("ordem"),
    sb.from("frota_status").select("veiculo_id,motorista,data").eq("data", PROG_DIA),
  ]);
  if(lin.error){ PROG.erro = lin.error.message; PROG.carregando = false; progRerender(); return; }
  PROG.erro = null;
  PROG.linhas = lin.data.map(r=>({ id:r.id, data:r.data, veiculoId:r.veiculo_id, frota:r.frota||"", motorista:r.motorista||"", cliente:r.cliente||"",
    transportadora:r.transportadora||"", servico:r.servico||"ENTREGA", horario:r.horario||"", nf:r.nf||"", planejado:r.planejado!==false,
    situacao:r.situacao||"pendente", horaReal:r.hora_real||"", motivo:r.motivo||"", motivoObs:r.motivo_obs||"", _tinhaMotivo:!!(r.motivo||r.motivo_obs), por:(r.atualizado_por||r.criado_por||"").split("@")[0] }));
  if(!vei.error) PROG.veiculos = vei.data.map(v=>({ id:v.id, ordem:v.ordem, placa:v.placa, motorista:v.motorista||"" }));
  PROG.motoristaDoDia = {};
  if(!st.error) st.data.forEach(r=>{ if(r.motorista) PROG.motoristaDoDia[r.veiculo_id] = r.motorista; });
  PROG.carregando = false; PROG.mesCarregado = mes;
  const assinatura = JSON.stringify(PROG.linhas);
  const mudou = assinatura !== PROG_ASSINATURA; PROG_ASSINATURA = assinatura;
  if(!silencioso || mudou) progRerender();
}
function progSalvarLocal(){ if(!PROG_DB) try{ localStorage.setItem(PROG_KEY, JSON.stringify(PROG.linhas)); }catch(e){} }
function progRerender(){
  if(document.querySelector('nav.menu button.active')?.dataset.page !== "entregas" || ENT_ABA !== "prog") return;
  const foco = document.activeElement;
  if(foco && foco.closest && foco.closest("#prog-form") && /INPUT|SELECT|TEXTAREA/.test(foco.tagName)) return; // não atrapalha quem está digitando
  const y = window.scrollY; document.getElementById("content").innerHTML = renderers.entregas(); window.scrollTo(0,y);
  requestAnimationFrame(progGrafico);
}
setInterval(()=>{ if(PROG_DB && ENT_ABA==="prog" && document.visibilityState==="visible" && document.querySelector('nav.menu button.active')?.dataset.page==="entregas") progCarregar(true); }, 30000);

window.progSetDia = (d) => { if(!d) return; PROG_DIA = d; const m = d.slice(0,7); if(m !== PROG_MES){ PROG_MES = m; progCarregar(); } else { progCarregar(); } };
window.progMoverDia = (n) => { const d = new Date(PROG_DIA+"T12:00:00"); d.setDate(d.getDate()+n); progSetDia(d.toISOString().slice(0,10)); };
window.progSetMes = (m) => { PROG_MES = m; const hoje = frotaHojeISO(); PROG_DIA = hoje.startsWith(m) ? hoje : `${m}-01`; progCarregar(); };
window.progForm = (campo, valor) => { PROG_FORM[campo] = valor; const y = window.scrollY; const dados = progLerForm(); document.getElementById("content").innerHTML = renderers.entregas(); progPreencherForm(dados); window.scrollTo(0,y); requestAnimationFrame(progGrafico); };
function progLerForm(){ const g = (id)=>document.getElementById(id)?.value || ""; return { frota:g("pg-frota"), motorista:g("pg-motorista"), cliente:g("pg-cliente"), transportadora:g("pg-transp"), horario:g("pg-horario"), nf:g("pg-nf") }; }
function progPreencherForm(d){ const s = (id,v)=>{ const el = document.getElementById(id); if(el && v!=null) el.value = v; };
  s("pg-frota", d.frota); s("pg-motorista", d.motorista); s("pg-cliente", d.cliente); s("pg-transp", d.transportadora); s("pg-horario", PROG_FORM.horario || d.horario); s("pg-nf", d.nf); }
// Campo Frota: a pessoa escolhe na lista ou digita (número "07", placa "GCV3D62" ou o começo dela "GCV3D")
function progRotuloFrota(v){ return `${String(v.ordem).padStart(2,"0")} · ${v.placa}`; }
function progAcharFrota(txt){
  const t = String(txt||"").toUpperCase().replace(/\s+/g," ").trim(); if(!t) return null;
  const semSep = t.replace(/[\s·.\-]/g,"");
  return PROG.veiculos.find(v=>progRotuloFrota(v).toUpperCase()===t)
      || PROG.veiculos.find(v=>v.placa.replace(/[\s-]/g,"")===semSep)
      || (/^\d{1,3}$/.test(t) ? PROG.veiculos.find(v=>v.ordem===parseInt(t,10)) : null)
      || (() => { const c = PROG.veiculos.filter(v=>v.placa.replace(/[\s-]/g,"").startsWith(semSep) || (String(v.ordem).padStart(2,"0")+v.placa.replace(/[\s-]/g,"")).startsWith(semSep)); return c.length===1 ? c[0] : null; })();
}
window.progEscolherFrota = (el) => {
  const v = progAcharFrota(el.value); if(!v) return;
  el.value = progRotuloFrota(v);
  const m = (PROG.motoristaDoDia && PROG.motoristaDoDia[v.id]) || v.motorista || "";
  const mot = document.getElementById("pg-motorista"); if(mot && m) mot.value = m.toUpperCase();
};
window.progMaiusc = (el) => { const p = el.selectionStart; el.value = el.value.toUpperCase(); try{ el.setSelectionRange(p,p); }catch(e){} };
window.progSoNumero = (el) => { el.value = el.value.replace(/\D/g,""); };
// NF: só números; várias notas separadas por "/" (vírgula, espaço ou ponto e vírgula viram "/")
function progLimparNF(v){ return String(v||"").replace(/[,;\s]+/g,"/").replace(/[^\d/]/g,"").replace(/\/{2,}/g,"/"); }
window.progNF = (el) => { el.value = progLimparNF(el.value); };

async function progGravar(linha){
  if(!PROG_DB){ const i = PROG.linhas.findIndex(l=>l.id===linha.id); if(i>=0) PROG.linhas[i] = linha; else PROG.linhas.push(linha); progSalvarLocal(); return true; }
  const reg = { data:linha.data, veiculo_id:linha.veiculoId||null, frota:linha.frota, motorista:linha.motorista||null, cliente:linha.cliente||null,
    transportadora:linha.transportadora||null, servico:linha.servico, horario:linha.horario||null, nf:linha.nf||null, planejado:linha.planejado,
    situacao:linha.situacao, hora_real:linha.horaReal||null, atualizado_por:MEU_EMAIL, atualizado_em:new Date().toISOString() };
  // motivo/detalhe só vão quando existem — assim, se o SQL das colunas novas ainda não foi rodado,
  // os demais lançamentos continuam salvando normalmente
  const temMotivo = linha.situacao==="nao_realizada" && (linha.motivo || linha.motivoObs);
  const comMotivo = temMotivo ? { ...reg, motivo:linha.motivo||null, motivo_obs:linha.motivoObs||null }
                  : (linha.situacao!=="nao_realizada" && linha._tinhaMotivo ? { ...reg, motivo:null, motivo_obs:null } : reg);
  const enviar = async (campos) => linha.id && !String(linha.id).startsWith("tmp")
    ? sb.from("entregas_programacao").update(campos).eq("id", linha.id).select().single()
    : sb.from("entregas_programacao").insert({ ...campos, criado_por:MEU_EMAIL }).select().single();
  let { data, error } = await enviar(comMotivo);
  if(error && /motivo/i.test(error.message||"")){
    ({ data, error } = await enviar(reg));
    if(!error){ PROG.semColunaMotivo = true; toast("⚠ Salvo, mas o motivo não foi gravado: falta rodar o SQL do motivo no Supabase."); }
  }
  if(error){ toast("⚠ Não salvou: " + error.message); return false; }
  linha._tinhaMotivo = !!temMotivo;
  linha.id = data.id; return true;
}

window.progAdicionar = async () => {
  const f = progLerForm();
  const v = progAcharFrota(f.frota);
  if(!v){ toast(f.frota ? `Não encontrei a frota "${f.frota}". Escolha uma da lista.` : "Escolha a frota."); return; }
  if(!f.cliente.trim()){ toast("Informe o cliente."); return; }
  const linha = { id:"tmp"+osNovoId(), data:PROG_DIA, veiculoId:v.id, frota:`${String(v.ordem).padStart(2,"0")} ${v.placa}`,
    motorista:f.motorista.trim().toUpperCase(), cliente:f.cliente.trim().toUpperCase(), transportadora:f.transportadora.trim().toUpperCase(),
    servico:PROG_FORM.servico, horario:f.horario, nf:progLimparNF(f.nf).replace(/^\/|\/$/g,""), planejado:PROG_FORM.planejado,
    situacao: PROG_FORM.planejado ? "pendente" : "realizada", horaReal: PROG_FORM.planejado ? "" : frotaHora(), por:(MEU_EMAIL||"").split("@")[0] };
  PROG.linhas.push(linha);
  // Mantém cliente, transportadora e horário no formulário (costumam se repetir); limpa frota, motorista e NF
  PROG_FORM.horario = f.horario;
  const manter = { cliente:f.cliente.toUpperCase(), transportadora:f.transportadora.toUpperCase(), horario:f.horario };
  const y = window.scrollY; document.getElementById("content").innerHTML = renderers.entregas(); progPreencherForm(manter); window.scrollTo(0,y); requestAnimationFrame(progGrafico);
  if(await progGravar(linha)) toast(`${linha.frota} adicionada ✓`);
};
window.progSituacao = async (id, sit) => {
  const l = PROG.linhas.find(x=>x.id===id); if(!l) return;
  l.situacao = l.situacao===sit ? "pendente" : sit;
  l.horaReal = l.situacao==="realizada" ? frotaHora() : "";
  if(l.situacao!=="nao_realizada"){ l.motivo = ""; l.motivoObs = ""; }
  l.por = (MEU_EMAIL||"").split("@")[0];
  progRerender(); await progGravar(l);
  if(l.situacao==="nao_realizada") setTimeout(()=>document.getElementById(`pg-mot-${id}`)?.focus(), 60);
};
window.progEditar = async (id, campo, valor) => {
  const l = PROG.linhas.find(x=>x.id===id); if(!l) return;
  l[campo] = campo==="nf" ? progLimparNF(valor).replace(/^\/|\/$/g,"") : ["horario","motivo","motivoObs"].includes(campo) ? valor.trim() : valor.toUpperCase();
  await progGravar(l); progRerender();
};
window.progExcluir = async (id) => {
  const l = PROG.linhas.find(x=>x.id===id); if(!l || !confirm(`Excluir ${l.frota} · ${l.cliente}${l.horario ? " · "+l.horario : ""}?`)) return;
  if(PROG_DB && !String(id).startsWith("tmp")){ const { error } = await sb.from("entregas_programacao").delete().eq("id", id); if(error){ toast("⚠ Não excluiu: " + error.message); return; } }
  PROG.linhas = PROG.linhas.filter(x=>x.id!==id); progSalvarLocal(); progRerender();
};
window.progCopiarUltimoDia = async () => {
  const anteriores = [...new Set(PROG.linhas.filter(l=>l.data<PROG_DIA && l.planejado).map(l=>l.data))].sort();
  const ult = anteriores[anteriores.length-1];
  if(!ult){ toast("Não encontrei programação nos dias anteriores."); return; }
  const base = progDoDia(ult).filter(l=>l.planejado);
  if(!confirm(`Copiar as ${base.length} entregas programadas de ${frotaDataBR(ult)} (${progDiaSemana(ult)}) para ${frotaDataBR(PROG_DIA)}?\n\nTodas entram como pendentes e sem NF.`)) return;
  for(const b of base){
    const linha = { ...b, id:"tmp"+osNovoId(), data:PROG_DIA, nf:"", situacao:"pendente", horaReal:"", planejado:true };
    PROG.linhas.push(linha); await progGravar(linha);
  }
  toast(`${base.length} entregas copiadas ✓`); progRerender();
};

function progTextoWhatsApp(){
  const itens = progDoDia(PROG_DIA), plan = itens.filter(l=>l.planejado);
  const real = itens.filter(l=>l.situacao==="realizada"), pend = itens.filter(l=>l.situacao==="pendente"), nao = itens.filter(l=>l.situacao==="nao_realizada");
  const extras = itens.filter(l=>!l.planejado);
  const pct = plan.length ? Math.round(real.filter(l=>l.planejado).length/plan.length*100) : 0;
  let t = `🚚 *PROGRAMAÇÃO DE ENTREGAS*\n📅 ${frotaDataBR(PROG_DIA)} (${progDiaSemana(PROG_DIA)})\n\n`;
  t += `📋 Planejado: *${plan.length}*\n✅ Realizado: *${real.length}*${extras.length ? ` (${extras.length} extra)` : ""}\n⏳ Pendente: *${pend.length}*\n`;
  if(nao.length) t += `❌ Não realizado: *${nao.length}*\n`;
  t += `🎯 Atendimento: *${pct}%*\n`;
  let horaAtual = null;
  itens.forEach(l=>{
    const h = l.horario || "Sem horário";
    // emojis só no cabeçalho/resumo; nas linhas das entregas, a situação vai escrita
    if(h !== horaAtual){ t += `\n*${h}*\n`; horaAtual = h; }
    const motivoTxt = l.situacao==="nao_realizada" && (l.motivo || l.motivoObs) ? ` — Motivo: ${[l.motivo, l.motivoObs].filter(Boolean).join(" / ")}` : "";
    t += `${l.frota}${l.motorista ? ` · ${l.motorista}` : ""} — ${PROG_SITUACAO[l.situacao].label.toUpperCase()}${motivoTxt}\n`;
    t += `   ${l.cliente}${l.transportadora ? ` · ${l.transportadora}` : ""}${l.nf ? ` · NF ${l.nf}` : ""}${l.servico!=="ENTREGA" ? ` · ${l.servico}` : ""}${!l.planejado ? " · EXTRA" : ""}\n`;
  });
  if(!itens.length) t += `\nNenhuma entrega lançada para o dia.\n`;
  return t.trim();
}
window.progCopiarWhatsApp = async () => {
  const txt = progTextoWhatsApp();
  try{ await navigator.clipboard.writeText(txt); toast("Mensagem copiada ✓ — é só colar no WhatsApp"); }
  catch(e){ const ta = document.getElementById("prog-wpp"); if(ta){ ta.select(); } toast("Selecione o texto e copie (Ctrl+C)."); }
};
window.progAbrirWhatsApp = () => { window.open("https://wa.me/?text=" + encodeURIComponent(progTextoWhatsApp()), "_blank"); };

function progStatsMes(){
  const dias = new Date(Number(PROG_MES.slice(0,4)), Number(PROG_MES.slice(5,7)), 0).getDate();
  const doMes = PROG.linhas.filter(l=>l.data.startsWith(PROG_MES));
  const porDia = Array.from({length:dias}, (_,i)=>{
    const d = `${PROG_MES}-${String(i+1).padStart(2,"0")}`, ls = doMes.filter(l=>l.data===d);
    return { d, plan:ls.filter(l=>l.planejado).length, real:ls.filter(l=>l.situacao==="realizada").length };
  });
  const plan = sumArr(porDia.map(x=>x.plan)), real = sumArr(porDia.map(x=>x.real));
  const realPlan = doMes.filter(l=>l.planejado && l.situacao==="realizada").length;
  return { porDia, plan, real, pct: plan ? realPlan/plan*100 : 0, diasComLanc: porDia.filter(x=>x.plan||x.real).length, extras: doMes.filter(l=>!l.planejado).length };
}

function progPagina(){
  if(PROG.mesCarregado !== PROG_MES && !PROG.carregando){ PROG.carregando = true; setTimeout(()=>progCarregar(), 0); }
  const itens = progDoDia(PROG_DIA), plan = itens.filter(l=>l.planejado);
  const real = itens.filter(l=>l.situacao==="realizada"), pend = itens.filter(l=>l.situacao==="pendente"), nao = itens.filter(l=>l.situacao==="nao_realizada");
  const pctDia = plan.length ? real.filter(l=>l.planejado).length/plan.length*100 : 0;
  const M = progStatsMes();
  const opt = (v,l,a) => `<option value="${v}" ${v===a?"selected":""}>${l}</option>`;
  const veics = PROG.veiculos.length ? PROG.veiculos : [];
  const historicoNomes = (campo, base) => [...new Set([...base, ...PROG.linhas.map(l=>l[campo]).filter(Boolean)])].sort();
  const hoje = PROG_DIA === frotaHojeISO();

  if(PROG.erro) return `<div class="panel"><div class="empty-state" style="padding:24px;"><div class="glyph">⚠️</div><h4>Não foi possível carregar a programação</h4><p>${osEsc(PROG.erro)}</p><p>Se falar em tabela inexistente ("entregas_programacao"), rode o SQL da programação no Supabase.</p></div></div>`;
  return `
    <div class="panel" style="margin-bottom:16px;">
      <div class="prog-topo">
        <div class="prog-dia">
          <button class="os-btn" onclick="progMoverDia(-1)" title="Dia anterior">◀</button>
          <input type="date" value="${PROG_DIA}" onchange="progSetDia(this.value)">
          <button class="os-btn" onclick="progMoverDia(1)" title="Próximo dia">▶</button>
          ${hoje ? `<span class="badge green">hoje</span>` : `<button class="os-link" onclick="progSetDia('${frotaHojeISO()}')">ir para hoje</button>`}
          <b style="text-transform:capitalize;">${progDiaSemana(PROG_DIA)}</b>
        </div>
        ${PROG_DB ? `<span class="hint" style="margin:0;">🟢 compartilhado · atualiza sozinho a cada 30s</span>` : `<span class="hint" style="margin:0;">🧪 modo local</span>`}
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">📋 Planejado</div><div class="val">${plan.length}</div><div class="delta flat">entregas programadas no dia</div></div>
      <div class="kpi"><div class="lbl">✅ Realizado</div><div class="val" style="color:var(--green);">${real.length}</div><div class="delta flat">${itens.filter(l=>!l.planejado).length} extra(s) fora do plano</div></div>
      <div class="kpi"><div class="lbl">⏳ Pendente</div><div class="val" style="color:var(--${pend.length?"amber":"ink"});">${pend.length}</div></div>
      <div class="kpi"><div class="lbl">❌ Não realizado</div><div class="val" style="color:var(--${nao.length?"red":"ink"});">${nao.length}</div></div>
      <div class="kpi"><div class="lbl">🎯 Atendimento do dia</div><div class="val">${pctDia.toFixed(0)}%</div><div class="delta flat">realizado ÷ planejado</div></div>
    </div>

    <div class="panel os-form" id="prog-form" style="margin-bottom:16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
        <h3 style="margin:0;">➕ Lançar entrega — ${frotaDataBR(PROG_DIA)}</h3>
        <button class="os-btn" onclick="progCopiarUltimoDia()">📋 Copiar programação do último dia</button>
      </div>
      <div class="prog-chips" style="margin-top:10px;">
        <span class="hint" style="margin:0;">Tipo:</span>
        <button class="sub-tab-btn ${PROG_FORM.planejado?"active":""}" onclick="progForm('planejado',true)">📋 Planejada</button>
        <button class="sub-tab-btn ${!PROG_FORM.planejado?"active":""}" onclick="progForm('planejado',false)">➕ Extra (fora do plano, já realizada)</button>
        <span class="hint" style="margin:0 0 0 10px;">Serviço:</span>
        ${PROG_SERVICOS.map(s=>`<button class="sub-tab-btn ${PROG_FORM.servico===s?"active":""}" onclick="progForm('servico','${s}')">${s}</button>`).join("")}
      </div>
      <div class="os-grid" style="margin-top:4px;">
        <label>🚛 Frota<input id="pg-frota" list="pg-l-frotas" placeholder="Digite ou escolha (ex: 07 ou GCV3D)" autocomplete="off" style="text-transform:uppercase;" onchange="progEscolherFrota(this)"></label>
        <datalist id="pg-l-frotas">${veics.map(v=>`<option value="${osEsc(progRotuloFrota(v))}">`).join("")}</datalist>
        <label>👤 Motorista<input id="pg-motorista" placeholder="NOME DO MOTORISTA" style="text-transform:uppercase;" oninput="progMaiusc(this)"></label>
        <label>🏢 Cliente<input id="pg-cliente" list="pg-l-clientes" placeholder="CLIENTE" style="text-transform:uppercase;" oninput="progMaiusc(this)"></label>
        <label>📦 Transportadora<input id="pg-transp" list="pg-l-transp" placeholder="TRANSPORTADORA" style="text-transform:uppercase;" oninput="progMaiusc(this)"></label>
        <label>🧾 NF<input id="pg-nf" inputmode="text" placeholder="ex: 12345/98745" oninput="progNF(this)"></label>
      </div>
      <label>🕐 Horário programado</label>
      <div class="prog-chips">
        ${PROG_HORARIOS.map(h=>`<button class="sub-tab-btn ${PROG_FORM.horario===h?"active":""}" onclick="progForm('horario','${h}')">${h}</button>`).join("")}
        <input type="time" id="pg-horario" step="900" value="${PROG_FORM.horario}" style="max-width:120px;" onchange="PROG_FORM.horario=this.value">
      </div>
      <datalist id="pg-l-clientes">${historicoNomes("cliente", PROG_SUG_CLIENTES).map(c=>`<option value="${osEsc(c)}">`).join("")}</datalist>
      <datalist id="pg-l-transp">${historicoNomes("transportadora", PROG_SUG_TRANSP).map(c=>`<option value="${osEsc(c)}">`).join("")}</datalist>
      <button class="entry-submit" onclick="progAdicionar()">Adicionar entrega</button>
      <span class="hint" style="margin-left:10px;">Depois de adicionar, cliente, transportadora e horário continuam preenchidos para agilizar o próximo.</span>
    </div>

    <div class="panel" style="margin-bottom:16px;">
      <h3>Entregas do dia (${itens.length})</h3>
      <div class="hint">Marque ✅ quando a entrega for realizada ou ❌ se não acontecer. Clique de novo para voltar a pendente. NF e horário podem ser ajustados aqui.</div>
      ${PROG.semColunaMotivo ? `<div class="os-alerta red">⛔ O <b>motivo da não realização não está sendo gravado</b>: falta criar as colunas no banco. Peça ao diretor para rodar o SQL do motivo no Supabase.</div>` : ""}
      ${itens.length ? `<div style="overflow-x:auto;"><table class="os-form prog-tab">
        <thead><tr><th>Horário</th><th>Frota</th><th>Motorista</th><th>Cliente</th><th>Transportadora</th><th>NF</th><th>Situação</th><th></th></tr></thead>
        <tbody>${itens.map(l=>`<tr class="sit-${l.situacao}">
          <td><input type="time" step="900" value="${l.horario}" style="width:96px;" onchange="progEditar('${l.id}','horario',this.value)"></td>
          <td><b>${osEsc(l.frota)}</b><div class="hint" style="margin:0;">${l.servico}${!l.planejado ? ' · <span class="badge amber">extra</span>' : ""}</div></td>
          <td>${osEsc(l.motorista)||"—"}</td><td>${osEsc(l.cliente)}</td><td>${osEsc(l.transportadora)||"—"}</td>
          <td><input value="${osEsc(l.nf)}" style="width:130px;" placeholder="12345/98745" oninput="progNF(this)" onchange="progEditar('${l.id}','nf',this.value)"></td>
          <td style="white-space:nowrap;">
            <button class="prog-sit ${l.situacao==="realizada"?"on ok":""}" onclick="progSituacao('${l.id}','realizada')" title="Realizada">✅</button>
            <button class="prog-sit ${l.situacao==="nao_realizada"?"on no":""}" onclick="progSituacao('${l.id}','nao_realizada')" title="Não realizada">❌</button>
            <span class="hint" style="margin:0 0 0 4px;">${l.situacao==="realizada" && l.horaReal ? `às ${l.horaReal}` : PROG_SITUACAO[l.situacao].label}</span>
            ${l.situacao==="nao_realizada" ? `<div class="prog-motivo">
              <select id="pg-mot-${l.id}" class="${l.motivo ? "" : "falta"}" onchange="progEditar('${l.id}','motivo',this.value)">
                <option value="">⚠️ Informe o motivo</option>${PROG_MOTIVOS.map(m=>`<option ${m===l.motivo?"selected":""}>${m}</option>`).join("")}
              </select>
              <input value="${osEsc(l.motivoObs)}" placeholder="detalhe (opcional)" onchange="progEditar('${l.id}','motivoObs',this.value)">
            </div>` : ""}
          </td>
          <td><button class="os-link" onclick="progExcluir('${l.id}')">excluir</button></td>
        </tr>`).join("")}</tbody></table></div>` : `<div class="empty-state" style="padding:18px;"><p>Nenhuma entrega lançada para este dia.</p></div>`}
    </div>

    <div class="panel" style="margin-bottom:16px;">
      <h3>💬 Mensagem do dia para o WhatsApp</h3>
      <div class="hint">Gerada a partir dos lançamentos. Para ver a mensagem de outro dia, troque a data no alto.</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="entry-submit" style="margin-top:0;" onclick="progCopiarWhatsApp()">📋 Copiar mensagem</button>
        <button class="os-btn green" onclick="progAbrirWhatsApp()">🟢 Abrir no WhatsApp</button>
      </div>
      <textarea id="prog-wpp" readonly class="frota-wpp">${osEsc(progTextoWhatsApp())}</textarea>
    </div>

    <div class="panel" style="margin-bottom:16px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">
        <div><h3 style="margin:0;">📊 Planejado x Realizado por dia — ${progNomeMes(PROG_MES)}</h3>
          <div class="hint">Quantidade de entregas. Clique numa coluna para abrir o dia.</div></div>
        <label class="frota-data">Mês <select onchange="progSetMes(this.value)">${progMesesOpcoes().map(m=>opt(m, progNomeMes(m), PROG_MES)).join("")}</select></label>
      </div>
      <div class="os-resumo prog-resumo" style="margin:4px 0 12px;">
        <div>Planejado no mês<b>${M.plan}</b></div>
        <div>Realizado no mês<b style="color:var(--green);">${M.real}</b><small>${M.extras} extra(s)</small></div>
        <div>Atendimento do plano<b>${M.pct.toFixed(0)}%</b></div>
        <div>Dias com lançamento<b>${M.diasComLanc}</b></div>
      </div>
      <div class="chart-wrap" style="height:320px;"><canvas id="ch-prog-mes"></canvas></div>
      <div class="hint" style="margin:8px 0 0;">Barra cinza = planejado · barra vermelha = realizado · número = realizado/planejado (<span style="color:var(--green);font-weight:700;">verde</span> bateu o plano, <span style="color:var(--red);font-weight:700;">vermelho</span> ficou abaixo)</div>
    </div>`;
}

// Planejado (barra cinza larga) com o Realizado (barra vermelha fina) por dentro, no mesmo lugar —
// um único rótulo "realizado/planejado" por dia. No celular o gráfico deita (um dia por linha).
let PROG_GRAF_MOBILE = null;
function progGrafico(){
  const el = document.getElementById("ch-prog-mes"); if(!el) return;
  const M = progStatsMes();
  const hoje = frotaHojeISO();
  // mês corrente: só até hoje (ou até o último dia lançado, se houver lançamento futuro)
  const ultimoLanc = M.porDia.filter(x=>x.plan||x.real).map(x=>x.d).pop() || "";
  const limite = PROG_MES === hoje.slice(0,7) ? (ultimoLanc > hoje ? ultimoLanc : hoje) : "9999";
  const dias = M.porDia.filter(x=>x.d <= limite);
  const SEM = ["dom","seg","ter","qua","qui","sex","sáb"];
  const sem = (d) => SEM[new Date(d+"T12:00:00").getDay()];
  const mobile = (el.parentElement.clientWidth || window.innerWidth) < 600;
  PROG_GRAF_MOBILE = mobile;
  const wrap = el.parentElement;
  wrap.style.height = mobile ? `${Math.max(220, dias.length*30 + 70)}px` : "320px";

  const rotulo = (x) => x.plan || x.real ? `${x.real}/${x.plan}` : "";
  const corRotulo = (x) => !x.plan ? COLORS.inkSoft : x.real >= x.plan ? COLORS.green : COLORS.red;
  const maxV = Math.max(1, ...dias.map(x=>Math.max(x.plan, x.real)));
  const eixoDia = { grid:{ display:false }, ticks:{ autoSkip:false, maxRotation:0, font:(c)=>({ size: mobile ? 11 : 10, weight: dias[c.index]?.d===PROG_DIA ? 800 : 400 }),
    color:(c)=> dias[c.index]?.d===PROG_DIA ? COLORS.ink : COLORS.inkSoft } };
  const eixoQtd = { beginAtZero:true, suggestedMax: Math.ceil(maxV*1.2), grid:{ color:COLORS.grid }, ticks:{ precision:0, color:COLORS.inkSoft } };

  mkChart("ch-prog-mes", {
    type:"bar",
    data:{
      labels: dias.map(x=> mobile ? `${x.d.slice(8,10)} ${sem(x.d)}` : [x.d.slice(8,10), sem(x.d).slice(0,3)]),
      datasets:[
        { label:"Planejado", data:dias.map(x=>x.plan), backgroundColor:"#D5D7DF", borderRadius:5, grouped:false, order:2,
          barPercentage: mobile ? 0.9 : 0.85, categoryPercentage:0.9 },
        { label:"Realizado", data:dias.map(x=>x.real), backgroundColor:COLORS.red, borderRadius:4, grouped:false, order:1,
          barPercentage: mobile ? 0.5 : 0.45, categoryPercentage:0.9 },
      ]},
    options:{ responsive:true, maintainAspectRatio:false, indexAxis: mobile ? "y" : "x",
      onClick:(_e, els)=>{ if(els.length) progSetDia(dias[els[0].index].d); },
      onHover:(e, els)=>{ e.native.target.style.cursor = els.length ? "pointer" : "default"; },
      plugins:{ legend:{ position: mobile ? "top" : "bottom", labels:{ boxWidth:12, usePointStyle:true, pointStyle:"rectRounded", padding:14 } },
        tooltip:{ mode:"index", intersect:false, callbacks:{
          title:(its)=>{ const x = dias[its[0].dataIndex]; return `${x.d.slice(8,10)}/${x.d.slice(5,7)} (${progDiaSemana(x.d)})`; },
          afterBody:(its)=>{ const x = dias[its[0].dataIndex]; return x.plan ? `Atendimento: ${Math.round(Math.min(x.real,x.plan)/x.plan*100)}%` : ""; } } },
        // um rótulo por dia, preso à barra mais alta do dia (planejado ou realizado)
        datalabels:{
          display:(c)=>{ const x = dias[c.dataIndex]; if(!(x.plan||x.real)) return false; return c.datasetIndex===0 ? x.plan>=x.real : x.real>x.plan; },
          formatter:(_v,c)=>rotulo(dias[c.dataIndex]), color:(c)=>corRotulo(dias[c.dataIndex]),
          anchor:"end", align: mobile ? "right" : "top", offset:2, clamp:true, font:{ size: mobile ? 11 : 10, weight:800 } } },
      layout:{ padding: mobile ? { right:40 } : { top:18 } },
      scales: mobile ? { y: eixoDia, x: { ...eixoQtd, position:"top" } } : { x: eixoDia, y: eixoQtd } }
  });
}
// Ao girar o celular ou redimensionar a janela, troca entre gráfico em pé e deitado
window.addEventListener("resize", ()=>{
  clearTimeout(window.__progResize);
  window.__progResize = setTimeout(()=>{
    const el = document.getElementById("ch-prog-mes"); if(!el) return;
    if(((el.parentElement.clientWidth || window.innerWidth) < 600) !== PROG_GRAF_MOBILE) progGrafico();
  }, 250);
});

renderers.entregas = () => {
  if(MEU_PAPEL === "monitoramento") ENT_ABA = "prog";
  const abas = MEU_PAPEL === "monitoramento" ? "" : `
    <div class="tabs" style="margin-bottom:14px;">
      <button class="tab-btn ${ENT_ABA==="prog"?"active":""}" onclick="setEntAba('prog')">📦 Programação diária</button>
      <button class="tab-btn ${ENT_ABA==="receita"?"active":""}" onclick="setEntAba('receita')">💰 Receita e viagens</button>
    </div>`;
  if(ENT_ABA === "prog") return `
    <div class="page-head"><h2>Programação diária de entregas</h2><p>Frota, motorista, cliente, transportadora, horário e NF — planejado x realizado, dia a dia</p></div>
    ${abas}${progPagina()}`;
  return abas + entregasReceita();
};
initCharts.entregas = () => { if(ENT_ABA === "prog") progGrafico(); else entregasReceitaCharts(); };
/* -------------------- EMISSÃO DE NF --------------------
   Lançamento e controle das notas de serviço. Usa a mesma tabela do Faturamento
   (faturamento_lancamentos), então tudo o que entra aqui aparece nos gráficos de lá e a importação
   da planilha do George continua valendo. O antigo campo "BALSA/VIAGEM" vira dois campos:
   Serviço/Balsa (lista) + Nº da balsa — e continua gravado no formato da planilha
   ("VALÊNCIA - 9252" ou "LOGÍSTICA REVERSA") para não quebrar nada. DOC = Entrega da minuta (data). */
const NF_SERVICOS = ["LOGÍSTICA REVERSA","RESÍDUO DE ENTREGA","MANUTENÇÃO","1º QZN DE ENTREGA","2º QZN DE ENTREGA","OPERAÇÃO BELÉM"];
const NF_OUTROS = "OUTROS SERVIÇOS";
const NF_BALSAS_PADRAO = ["ANTUÉRPIA","BARCELONA","CASA BLANCA","DUBAI","GENOVA","LISBOA","LOS ANGELES","MELBOURNE","MIAMI","OSAKA","OSLO","ROTTERDAM","SINGAPUR","TBL LV","TBL XXXV","TOKYO","VALÊNCIA","XANGAI","YOKOHAMA"];
const FILTRO_NF = { mes:null, item:"todos", busca:"", pendentes:false };
let NF_EDIT = null;   // id do lançamento em edição (null = novo)
let NF_SEL = "";      // serviço/balsa escolhido no formulário

function nfSemAcento(s){ return String(s||"").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g,"").trim(); }
// Lê o texto do campo BALSA/VIAGEM (como veio da planilha) e separa em serviço / balsa + número
function nfClassificar(raw){
  const s = String(raw||"").replace(/\s+/g," ").trim();
  if(!s) return { item:NF_OUTROS, tipo:"servico", numero:"", original:"" };
  const u = nfSemAcento(s);
  const servico = (nome, numero="") => ({ item:nome, tipo:"servico", numero, original:s });
  if(/OPERA..O BEL/.test(u)) return servico("OPERAÇÃO BELÉM", (u.match(/(\d{1,2})[./](\d{2,4})/)||[]).slice(1).join("/"));
  if(/RESIDUO/.test(u)) return servico("RESÍDUO DE ENTREGA");
  if(/2.? ?QZN/.test(u)) return servico("2º QZN DE ENTREGA");
  if(/1.? ?QZN/.test(u)) return servico("1º QZN DE ENTREGA");
  if(/LOG/.test(u) && /REVER|VER\b|VER\//.test(u)) return servico("LOGÍSTICA REVERSA");
  if(/MANUT/.test(u)) return servico("MANUTENÇÃO");
  if(/MOVIMENT|ATRELAMENTO|CARRETEIRA/.test(u)) return { item:NF_OUTROS, tipo:"servico", numero:"", original:s };
  // Balsa: "NOME - 1234" (ou só "NOME")
  const m = s.match(/^(.*?)\s*[-–]\s*([\d./ ]+)$/);
  let nome = (m ? m[1] : s).toUpperCase().trim();
  if(nfSemAcento(nome).replace(/\s/g,"") === "CASABLANCA") nome = "CASA BLANCA";
  return { item:nome, tipo:"balsa", numero: m ? m[2].trim() : "", original:s };
}
function nfMontarBalsaViagem(item, numero){
  if(!item) return null;
  const n = String(numero||"").trim();
  if(item === "OPERAÇÃO BELÉM") return n ? `OPERAÇÃO BELÉM/${n.replace("/",".")}` : "OPERAÇÃO BELÉM";
  if(NF_SERVICOS.includes(item) || item === NF_OUTROS) return item;
  return n ? `${item} - ${n}` : item;
}
function nfEhBalsa(item){ return !!item && !NF_SERVICOS.includes(item) && item !== NF_OUTROS; }
function nfBalsasConhecidas(){
  const daBase = DATA.faturamento.lancamentos.map(r=>nfClassificar(r.balsaViagem)).filter(c=>c.tipo==="balsa").map(c=>c.item);
  return [...new Set([...NF_BALSAS_PADRAO, ...daBase])].sort((a,b)=>a.localeCompare(b,"pt-BR"));
}
function nfMinuta(r){ return r.doc && /^\d{4}-\d{2}-\d{2}$/.test(r.doc) ? r.doc : null; }
function nfMesRef(r){ return (r.vencimento || r.deadline || "").slice(0,7); }

window.setFiltroNF = (campo, valor) => { FILTRO_NF[campo] = valor; navigate("emissaonf"); };
window.nfBuscar = (t) => { FILTRO_NF.busca = t; const y = window.scrollY; document.getElementById("content").innerHTML = renderers.emissaonf(); window.scrollTo(0,y); const el = document.getElementById("nf-busca"); if(el){ el.focus(); el.setSelectionRange(t.length,t.length); } };
window.nfEscolherItem = (sel) => {
  if(sel.value === "__nova"){
    const nome = (prompt("Nome da nova balsa:")||"").trim().toUpperCase();
    if(!nome){ sel.value = NF_SEL; return; }
    NF_BALSAS_PADRAO.push(nome); NF_SEL = nome;
  } else NF_SEL = sel.value;
  const dados = nfLerForm(); navigate("emissaonf"); nfPreencherForm({ ...dados, item:NF_SEL });
};
window.nfLimparDigitos = (el, extra) => { el.value = el.value.replace(new RegExp(`[^\\d${extra||""}]`,"g"),""); };

function nfLerForm(){
  const g = (id)=>document.getElementById(id)?.value || "";
  return { contrato:g("nf-contrato"), nf:g("nf-nf"), deadline:g("nf-deadline"), minuta:g("nf-minuta"), item:NF_SEL, numero:g("nf-numero"), valor:g("nf-valor"), vencimento:g("nf-venc") };
}
function nfPreencherForm(d){
  const s = (id,v)=>{ const el = document.getElementById(id); if(el && v!=null) el.value = v; };
  s("nf-contrato", d.contrato); s("nf-nf", d.nf); s("nf-deadline", d.deadline); s("nf-minuta", d.minuta);
  s("nf-item", d.item); s("nf-numero", d.numero); s("nf-valor", d.valor); s("nf-venc", d.vencimento);
}
window.nfEditar = (id) => {
  const r = DATA.faturamento.lancamentos.find(x=>x.id===id); if(!r) return;
  const c = nfClassificar(r.balsaViagem);
  NF_EDIT = id; NF_SEL = c.item;
  navigate("emissaonf");
  nfPreencherForm({ contrato:r.contrato||"", nf:r.nf||"", deadline:r.deadline||"", minuta:nfMinuta(r)||"", item:c.item, numero:c.numero,
    valor:r.valor!=null ? "R$ "+Number(r.valor).toLocaleString("pt-BR",{minimumFractionDigits:2, maximumFractionDigits:2}) : "", vencimento:r.vencimento||"" });
  document.getElementById("nf-form")?.scrollIntoView({ behavior:"smooth", block:"start" });
};
window.nfCancelar = () => { NF_EDIT = null; NF_SEL = ""; navigate("emissaonf"); };

window.nfSalvar = async () => {
  const f = nfLerForm();
  const valor = osNum("nf-valor");
  if(!f.item){ toast("Escolha o serviço ou a balsa."); return; }
  if(!valor){ toast("Informe o valor."); return; }
  if(!f.vencimento){ toast("Informe o vencimento."); return; }
  if(nfEhBalsa(f.item) && !f.numero.trim() && !confirm("Balsa sem número. Salvar assim mesmo?")) return;
  const reg = { contrato:f.contrato.trim()||null, nf:f.nf.replace(/^\/|\/$/g,"").trim()||null, deadline:f.deadline||null,
    doc:f.minuta||null, balsaViagem:nfMontarBalsaViagem(f.item, f.numero), valor, vencimento:f.vencimento };
  const banco = { contrato:reg.contrato, nf:reg.nf, deadline:reg.deadline, doc:reg.doc, balsa_viagem:reg.balsaViagem, valor:reg.valor, vencimento:reg.vencimento };
  const lista = DATA.faturamento.lancamentos;
  if(NF_EDIT){
    const r = lista.find(x=>x.id===NF_EDIT);
    if(sb){ const { error } = await sb.from("faturamento_lancamentos").update(banco).eq("id", NF_EDIT); if(error){ toast("⚠ Não salvou: " + error.message); return; } }
    Object.assign(r, reg);
    toast("Lançamento atualizado ✓");
  } else {
    const novo = { id:localId(), ...reg };
    if(sb){ const { data, error } = await sb.from("faturamento_lancamentos").insert(banco).select().single(); if(error){ toast("⚠ Não salvou: " + error.message); return; } novo.id = data.id; }
    lista.push(novo);
    toast(`${reg.balsaViagem} · ${fmtBRL2(valor)} lançado ✓`);
  }
  NF_EDIT = null; NF_SEL = "";
  FILTRO_NF.mes = nfMesRef(reg) || FILTRO_NF.mes;
  navigate("emissaonf");
};
window.nfExcluir = async (id) => {
  const r = DATA.faturamento.lancamentos.find(x=>x.id===id); if(!r) return;
  if(!confirm(`Excluir o lançamento ${r.balsaViagem||""} · ${fmtBRL2(r.valor)} (vencimento ${fmtDataBR(r.vencimento)})?`)) return;
  if(sb){ const { error } = await sb.from("faturamento_lancamentos").delete().eq("id", id); if(error){ toast("⚠ Não excluiu: " + error.message); return; } }
  DATA.faturamento.lancamentos = DATA.faturamento.lancamentos.filter(x=>x.id!==id);
  navigate("emissaonf");
};

// Aba "Notas fiscais" da tela Emissão de NF
function nfPaginaNotas(){
  const todos = DATA.faturamento.lancamentos;
  const meses = [...new Set(todos.map(nfMesRef).filter(Boolean))].sort().reverse();
  const hojeMes = frotaHojeISO().slice(0,7);
  if(!FILTRO_NF.mes) FILTRO_NF.mes = meses.includes(hojeMes) ? hojeMes : (meses[0] || hojeMes);
  const nomeMes = (m) => m==="todos" ? "Todos os meses" : `${MESES_HE[Number(m.slice(5,7))-1]}/${m.slice(2,4)}`;
  const balsas = nfBalsasConhecidas();
  const opt = (v,l,a) => `<option value="${osEsc(v)}" ${v===a?"selected":""}>${osEsc(l)}</option>`;

  const doMes = todos.filter(r=>FILTRO_NF.mes==="todos" || nfMesRef(r)===FILTRO_NF.mes);
  const busca = nfSemAcento(FILTRO_NF.busca);
  const lista = doMes.filter(r=>{
    const c = nfClassificar(r.balsaViagem);
    if(FILTRO_NF.item!=="todos" && c.item!==FILTRO_NF.item) return false;
    if(FILTRO_NF.pendentes && r.nf) return false;
    if(busca && !nfSemAcento(`${r.contrato||""} ${r.nf||""} ${r.balsaViagem||""}`).includes(busca)) return false;
    return true;
  }).sort((a,b)=>(a.vencimento||"9").localeCompare(b.vencimento||"9") || (a.deadline||"").localeCompare(b.deadline||""));

  const semNF = doMes.filter(r=>!r.nf), semMinuta = doMes.filter(r=>!nfMinuta(r));
  const hoje = frotaHojeISO(), em7 = new Date(hoje+"T12:00:00"); em7.setDate(em7.getDate()+7);
  const venceSemana = doMes.filter(r=>r.vencimento && r.vencimento>=hoje && r.vencimento<=em7.toISOString().slice(0,10));
  const porItem = {};
  doMes.forEach(r=>{ const c = nfClassificar(r.balsaViagem); const k = c.tipo==="balsa" ? "BALSAS" : c.item; porItem[k] = (porItem[k]||0) + (r.valor||0); });
  const totalMes = sumArr(doMes.map(r=>r.valor||0));
  const resumo = Object.entries(porItem).sort((a,b)=>b[1]-a[1]);

  const itemSel = NF_SEL;
  return `

    <div class="panel os-form" id="nf-form" style="margin-bottom:16px; ${NF_EDIT ? "border:2px solid var(--amber);" : ""}">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
        <h3 style="margin:0;">${NF_EDIT ? "✏️ Editando lançamento" : "➕ Novo lançamento"}</h3>
        ${NF_EDIT ? `<button class="os-btn" onclick="nfCancelar()">Cancelar edição</button>` : ""}
      </div>
      <div class="nf-grid">
        <label>Contrato<input id="nf-contrato" inputmode="numeric" placeholder="ex: 045 ou 045/046" oninput="nfLimparDigitos(this,'/\\-')"></label>
        <label>NF<input id="nf-nf" inputmode="numeric" placeholder="ex: 1234 ou 1234/1235" oninput="progNF(this)"></label>
        <label title="Data do serviço executado">Deadline (execução)<input type="date" id="nf-deadline"></label>
        <label>Entrega da minuta<input type="date" id="nf-minuta"></label>
      </div>
      <div class="nf-grid nf-grid-2">
        <label>Serviço / Balsa<select id="nf-item" onchange="nfEscolherItem(this)">
          <option value="">Selecione</option>
          <optgroup label="Serviços">${NF_SERVICOS.map(s=>opt(s,s,itemSel)).join("")}${opt(NF_OUTROS, "Outros serviços (movimentação, atrelamento...)", itemSel)}</optgroup>
          <optgroup label="Balsas">${balsas.map(b=>opt(b,b,itemSel)).join("")}<option value="__nova">+ Cadastrar outra balsa…</option></optgroup>
        </select></label>
        <label>${itemSel==="OPERAÇÃO BELÉM" ? "Referência (mês/ano)" : "Nº da balsa"}<input id="nf-numero" ${nfEhBalsa(itemSel) || itemSel==="OPERAÇÃO BELÉM" ? "" : "disabled"}
          placeholder="${itemSel==="OPERAÇÃO BELÉM" ? "ex: 08/26" : nfEhBalsa(itemSel) ? "ex: 9252" : "só para balsas"}" inputmode="numeric" oninput="nfLimparDigitos(this,'/')"></label>
        <label>Valor<input id="nf-valor" inputmode="numeric" placeholder="R$ 0,00" oninput="osMascaraBRL(this)"></label>
        <label>Vencimento<input type="date" id="nf-venc"></label>
      </div>
      <button class="entry-submit" onclick="nfSalvar()">${NF_EDIT ? "Salvar alterações" : "Lançar"}</button>
    </div>

    <div class="panel" style="margin-bottom:16px;">
      <div class="filtro-bar">
        <label>Mês (vencimento)<select onchange="setFiltroNF('mes',this.value)">${opt("todos","Todos os meses",FILTRO_NF.mes)}${meses.map(m=>opt(m, nomeMes(m), FILTRO_NF.mes)).join("")}</select></label>
        <label>Serviço / Balsa<select onchange="setFiltroNF('item',this.value)">${opt("todos","Todos",FILTRO_NF.item)}
          <optgroup label="Serviços">${[...NF_SERVICOS, NF_OUTROS].map(s=>opt(s,s,FILTRO_NF.item)).join("")}</optgroup>
          <optgroup label="Balsas">${balsas.map(b=>opt(b,b,FILTRO_NF.item)).join("")}</optgroup></select></label>
        <label>Buscar<input id="nf-busca" value="${osEsc(FILTRO_NF.busca)}" placeholder="contrato, NF ou balsa" oninput="nfBuscar(this.value)"
          style="font-family:inherit; font-size:13px; padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:var(--paper);"></label>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Lançamentos — ${nomeMes(FILTRO_NF.mes)}</div><div class="val">${doMes.length}</div><div class="delta flat">${fmtBRL(totalMes)}</div></div>
      <div class="kpi" style="cursor:pointer;" onclick="setFiltroNF('pendentes', ${!FILTRO_NF.pendentes})"><div class="lbl">🧾 Sem NF emitida</div><div class="val" style="color:var(--${semNF.length?"amber":"green"});">${semNF.length}</div><div class="delta flat">${FILTRO_NF.pendentes ? "✓ mostrando só esses · clique para ver todos" : "clique para ver só esses"}</div></div>
      <div class="kpi"><div class="lbl">📄 Minuta não entregue</div><div class="val" style="color:var(--${semMinuta.length?"amber":"green"});">${semMinuta.length}</div><div class="delta flat">sem data de entrega da minuta</div></div>
      <div class="kpi"><div class="lbl">📅 Vencem nos próximos 7 dias</div><div class="val">${venceSemana.length}</div><div class="delta flat">${fmtBRL(sumArr(venceSemana.map(r=>r.valor||0)))}</div></div>
    </div>

    ${resumo.length ? `<div class="panel" style="margin-bottom:16px;">
      <h3>Valor por serviço — ${nomeMes(FILTRO_NF.mes)}</h3>
      <div class="nf-resumo">${resumo.map(([k,v])=>`<div><span>${osEsc(k)}</span><b>${fmtBRL(v)}</b><small>${totalMes?(v/totalMes*100).toFixed(0):0}%</small></div>`).join("")}</div>
    </div>` : ""}

    <div class="panel">
      <h3>Lançamentos (${lista.length})</h3>
      <div class="hint">Ordenados por vencimento. Clique em ✏️ para corrigir um lançamento.</div>
      ${lista.length ? `<div style="overflow-x:auto;"><table class="nf-tab">
        <thead><tr><th>Contrato</th><th>NF</th><th>Deadline</th><th>Entrega da minuta</th><th>Serviço / Balsa</th><th>Nº balsa</th><th class="num">Valor</th><th>Vencimento</th><th></th></tr></thead>
        <tbody>${lista.map(r=>{ const c = nfClassificar(r.balsaViagem); const min = nfMinuta(r);
          const vencida = r.vencimento && r.vencimento < hoje;
          return `<tr ${NF_EDIT===r.id?'style="background:#FCF1DE;"':""}>
            <td><b>${osEsc(r.contrato)||"—"}</b></td>
            <td>${r.nf ? osEsc(r.nf) : '<span class="badge amber">sem NF</span>'}</td>
            <td>${fmtDataBR(r.deadline)}</td>
            <td>${min ? fmtDataBR(min) : (r.doc && r.doc!=="-" ? osEsc(r.doc) : '<span class="badge gray">pendente</span>')}</td>
            <td>${c.tipo==="balsa" ? `🚢 <b>${osEsc(c.item)}</b>` : osEsc(c.item)}${c.item===NF_OUTROS && c.original ? `<div class="hint" style="margin:0;">${osEsc(c.original)}</div>` : ""}</td>
            <td>${osEsc(c.numero)||"—"}</td>
            <td class="num"><b>${fmtBRL2(r.valor)}</b></td>
            <td style="white-space:nowrap;">${fmtDataBR(r.vencimento)}${vencida ? ' <span class="badge gray">vencido</span>' : ""}</td>
            <td style="white-space:nowrap;"><button class="os-link" onclick="nfEditar('${r.id}')" title="Editar">✏️</button> <button class="os-link" onclick="nfExcluir('${r.id}')" title="Excluir">🗑️</button></td>
          </tr>`; }).join("")}</tbody>
        <tfoot><tr style="font-weight:800; background:var(--paper);"><td colspan="6">Total</td><td class="num">${fmtBRL2(sumArr(lista.map(r=>r.valor||0)))}</td><td colspan="2"></td></tr></tfoot>
      </table></div>` : `<div class="empty-state" style="padding:20px;"><p>Nenhum lançamento com esses filtros.</p></div>`}
    </div>`;
};

/* Abas da tela Emissão de NF: "nf" (Contratos) e "nfe" (NF Emitidas).
   As abas O.S de Manutenção e O.S Financeira foram retiradas (as O.S já lançadas continuam guardadas na
   tabela manutencao_os do banco). */
let NF_ABA = "nf";
window.setNfAba = (a) => { NF_ABA = a; navigate("emissaonf"); };
/* -------------------- NF EMITIDAS (aba da Emissão de NF) --------------------
   Registro das notas fiscais emitidas por atividade + PAINEL DE EMISSÃO: cada serviço tem um ritmo de
   faturamento (semanal, quinzenal ou mensal) e um prazo para a NF. Para cada período o painel mostra:
     verde    = NF lançada para o período (ou marcado "sem operação")
     amarelo  = marcado "em andamento" (com o motivo)
     vermelho = chegou o prazo (dia útil) e não há NF
     cinza    = período em execução / ainda antes do prazo
   Tabelas: nf_emitidas (com a coluna "periodo") e nf_painel (status manual + observação por período). */
const NFE_ATIVIDADES = [
  { chave:"lr_sw",            label:"Logística Reversa SW",          sentido:true,  cad:"semanal",   semPeriodo:true, doc:"RQ",     cor:"#2E6DB0" },
  { chave:"desatrelamento",   label:"Desatrelamento SW",             sentido:false, cad:"semanal",   semPeriodo:true, doc:"RQ",     cor:"#8E2EB0" },
  { chave:"puxadas",          label:"Puxada de carreta avaria NC",   sentido:false, cad:"semanal",   semPeriodo:true, doc:"E-mail", cor:"#E1971F" },
  { chave:"devolucao_motos",  label:"Devolução de motos",            sentido:false, cad:"mensal",    periodoLivre:true, doc:"E-mail", cor:"#147A55" },
  { chave:"contrato_sw_motos",label:"Contrato SW motos",             sentido:false, cad:null, oculto:true, doc:"", cor:"#8C0011" },   // não emite NF (fica só para lançamentos antigos)
  { chave:"entregas",         label:"Entregas",                      sentido:false, cad:null, oculto:true, doc:"", cor:"#4A86C8" },   // não emite NF (fica só para lançamentos antigos)
  { chave:"manutencao",       label:"Manutenção de Carreta",         sentido:false, cad:"semanal",   periodoLivre:true, doc:"", cor:"#D0021B" },
  { chave:"lr_carreteira",    label:"Logística Reversa Carreteira",  sentido:true,  cad:null,        doc:"",       cor:"#1C9A6C" },
  { chave:"outros",           label:"Outros serviços (LSL / outros)",sentido:false, cad:null,        doc:"",       cor:"#5B5F6B" },
];
const NFE_INICIO_CONTROLE = "2026-10-01";   // períodos antes disso não entram no painel
const NFE_CAD_LABEL = { semanal:"Semanal — NF na semana seguinte", quinzenal:"Quinzenal — NF no dia 16 e no dia 1º", mensal:"Mensal — NF no início do mês seguinte" };
// Feriados nacionais fixos (o prazo que cai neles passa para o próximo dia útil)
const NFE_FERIADOS = ["01-01","04-21","05-01","09-07","10-12","11-02","11-15","11-20","12-25"];
const NFE_LOCAL_KEY = "avance_nf_emitidas_v1", NFE_PAINEL_LOCAL = "avance_nf_painel_v1";
let NFE = { lista:[], painel:{}, carregado:false, carregando:false, erro:null };
let NFE_FILTRO = { mes:null, atividade:"todas", busca:"", sit:"pendentes" };
let NFE_EDIT = null, NFE_ATIV = "", NFE_SENTIDO = "", NFE_PERIODO = "";
let NFE_CARD_SEL = {};   // período escolhido em cada cartão do painel

function nfeAtiv(ch){ return NFE_ATIVIDADES.find(a=>a.chave===ch) || { chave:ch, label:ch||"—", cor:"#5B5F6B" }; }
function nfeRotulo(r){ return `${nfeAtiv(r.atividade).label}${r.sentido ? ` — ${r.sentido==="sobe" ? "Subindo" : "Descendo"}` : ""}`; }

/* ---------- Datas, períodos e prazos ---------- */
const nfeISO = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const nfeDate = (iso) => new Date(iso+"T12:00:00");
function nfeDiaUtil(iso){ const d = nfeDate(iso), w = d.getDay(); return w!==0 && w!==6 && !NFE_FERIADOS.includes(iso.slice(5)); }
function nfeProxUtil(iso){ let d = nfeDate(iso); while(!nfeDiaUtil(nfeISO(d))) d.setDate(d.getDate()+1); return nfeISO(d); }
function nfeAddDias(iso, n){ const d = nfeDate(iso); d.setDate(d.getDate()+n); return nfeISO(d); }
function nfeSegunda(iso){ const d = nfeDate(iso), w = (d.getDay()+6)%7; d.setDate(d.getDate()-w); return nfeISO(d); }
function nfeFimMes(ym){ const [a,m] = ym.split("-").map(Number); return nfeISO(new Date(a, m, 0, 12)); }
function nfeMesSeg(ym){ const [a,m] = ym.split("-").map(Number); return nfeISO(new Date(a, m, 1, 12)).slice(0,7); }
const nfeBR = (iso) => `${iso.slice(8,10)}/${iso.slice(5,7)}`;
const nfeNomeMes = (ym) => `${MESES_HE[Number(ym.slice(5,7))-1]}/${ym.slice(2,4)}`;

// Período = { chave, ini, fim, prazo, rotulo }
function nfePeriodoDe(cad, iso){
  if(cad === "semanal"){ const ini = nfeSegunda(iso), fim = nfeAddDias(ini, 6);
    return { chave:`S:${ini}`, ini, fim, prazo:nfeProxUtil(nfeAddDias(ini, 7)), rotulo:`Semana ${nfeBR(ini)} a ${nfeBR(fim)}` }; }
  if(cad === "quinzenal"){ const ym = iso.slice(0,7), q1 = Number(iso.slice(8,10)) <= 15;
    return q1 ? { chave:`Q:${ym}-1`, ini:`${ym}-01`, fim:`${ym}-15`, prazo:nfeProxUtil(`${ym}-16`), rotulo:`1ª quinzena ${nfeNomeMes(ym)} (01 a 15)` }
              : { chave:`Q:${ym}-2`, ini:`${ym}-16`, fim:nfeFimMes(ym), prazo:nfeProxUtil(`${nfeMesSeg(ym)}-01`), rotulo:`2ª quinzena ${nfeNomeMes(ym)} (16 a ${nfeFimMes(ym).slice(8)})` }; }
  const ym = iso.slice(0,7);
  return { chave:`M:${ym}`, ini:`${ym}-01`, fim:nfeFimMes(ym), prazo:nfeProxUtil(`${nfeMesSeg(ym)}-01`), rotulo:`${MESES_HE[Number(ym.slice(5,7))-1][0].toUpperCase()+MESES_HE[Number(ym.slice(5,7))-1].slice(1)}/${ym.slice(2,4)}` };
}
function nfePeriodoPorChave(cad, chave){ if(!chave) return null; const iso = chave.startsWith("Q:") ? `${chave.slice(2,9)}-${chave.endsWith("-1") ? "01" : "16"}` : chave.startsWith("M:") ? `${chave.slice(2)}-01` : chave.slice(2); return nfePeriodoDe(cad, iso); }
// Períodos do início do controle até o atual (inclusive), do mais recente para o mais antigo
function nfePeriodos(cad){
  const hoje = frotaHojeISO(), lista = [];
  let p = nfePeriodoDe(cad, NFE_INICIO_CONTROLE);
  while(p.ini <= hoje && lista.length < 80){ lista.push(p); p = nfePeriodoDe(cad, nfeAddDias(p.fim, 1)); }
  return lista.reverse();
}

/* ---------- Status de um período ---------- */
function nfeStatus(atividade, p){
  const hoje = frotaHojeISO();
  const nfs = NFE.lista.filter(r=>r.atividade===atividade && nfeCobre(r, p, nfeAtiv(atividade)));
  const man = NFE.painel[`${atividade}|${p.chave}`] || {};
  if(nfs.length) return { cor:"verde", texto:"NF emitida", nfs, man };
  if(man.status === "sem_operacao") return { cor:"verde", texto:"Sem operação no período", nfs, man };
  if(man.status === "andamento") return { cor:"amarelo", texto: hoje >= p.prazo ? "Em andamento (prazo vencido)" : "Em andamento", nfs, man };
  if(hoje >= p.prazo) return { cor:"vermelho", texto:`Atrasada — prazo era ${nfeBR(p.prazo)}`, nfs, man };
  if(hoje <= p.fim) return { cor:"cinza", texto:"Período em execução", nfs, man };
  return { cor:"cinza", texto:`Aguardando — prazo ${nfeBR(p.prazo)}`, nfs, man };
}
function nfeResumoAtividade(a){
  const per = nfePeriodos(a.cad).map(p=>({ p, st:nfeStatus(a.chave, p) }));
  const vermelhos = per.filter(x=>x.st.cor==="vermelho"), amarelos = per.filter(x=>x.st.cor==="amarelo");
  const cor = vermelhos.length ? "vermelho" : amarelos.length ? "amarelo" : per.some(x=>x.st.cor==="verde") ? "verde" : "cinza";
  // período em foco: o pendente mais antigo; senão o último que já passou do fim; senão o atual
  const foco = vermelhos[vermelhos.length-1] || amarelos[amarelos.length-1] || per.find(x=>x.p.fim < frotaHojeISO()) || per[0];
  return { per, cor, vermelhos:vermelhos.length, amarelos:amarelos.length, foco };
}
// A NF conta para o período quando: é do próprio período (chave), cobre parte dele com datas livres
// ("D:inicio:fim", Manutenção) ou — nas semanais sem campo de período — foi emitida na semana seguinte.
function nfeCobre(r, p, a){
  if(r.periodo === p.chave) return true;
  if(r.periodo && r.periodo.startsWith("D:")){ const [, ini, fim] = r.periodo.split(":"); return ini <= p.fim && fim >= p.ini; }
  if(a && a.semPeriodo && !r.periodo && r.dataEmissao){ const ini = nfeAddDias(p.fim, 1), fim = nfeAddDias(p.fim, 7); return r.dataEmissao >= ini && r.dataEmissao <= fim; }
  return false;
}
const NFE_VISIVEIS = () => NFE_ATIVIDADES.filter(a=>!a.oculto || NFE.lista.some(r=>r.atividade===a.chave));
// Período sugerido no formulário: o pendente mais antigo, ou o último período encerrado
function nfePeriodoSugerido(ch){
  const a = nfeAtiv(ch); if(!a.cad || a.semPeriodo) return "";
  if(ch==="manutencao" && typeof manCiclos==="function"){ const x = manCiclos().filter(c=>c.st==="pend_nf").pop(); if(x) return `D:${x.ini}:${x.fim}`; }
  const r = nfeResumoAtividade(a); if(!r.foco) return "";
  return a.periodoLivre ? `D:${r.foco.p.ini}:${r.foco.p.fim}` : r.foco.p.chave;
}

/* ---------- Carga e gravação ---------- */
async function nfeCarregar(){
  NFE.carregando = true;
  if(!sb){
    try{ NFE.lista = JSON.parse(localStorage.getItem(NFE_LOCAL_KEY)||"[]"); NFE.painel = JSON.parse(localStorage.getItem(NFE_PAINEL_LOCAL)||"{}"); }catch(e){ NFE.lista = []; NFE.painel = {}; }
  } else {
    const [l, p] = await Promise.all([ sb.from("nf_emitidas").select("*").order("data_emissao", { ascending:false }), sb.from("nf_painel").select("*") ]);
    if(l.error){ NFE.erro = l.error.message; NFE.carregando = false; NFE.carregado = true; nfeRerender(); return; }
    NFE.erro = null;
    NFE.lista = l.data.map(r=>({ id:r.id, atividade:r.atividade, sentido:r.sentido||"", periodo:r.periodo||"", numero:r.numero||"", nf:r.nf||"", valor:Number(r.valor)||0,
      dataEmissao:r.data_emissao, dataPagamento:r.data_pagamento||"", balsa:r.balsa||"", obs:r.obs||"", por:(r.atualizado_por||r.criado_por||"").split("@")[0] }));
    NFE.painel = {};
    if(!p.error) p.data.forEach(r=>{ NFE.painel[`${r.atividade}|${r.periodo}`] = { status:r.status||"", obs:r.obs||"", por:(r.atualizado_por||"").split("@")[0], em:r.atualizado_em }; });
    else NFE.erroPainel = p.error.message;
  }
  NFE.carregando = false; NFE.carregado = true; nfeRerender();
}
function nfeSalvarLocal(){ if(!sb) try{ localStorage.setItem(NFE_LOCAL_KEY, JSON.stringify(NFE.lista)); localStorage.setItem(NFE_PAINEL_LOCAL, JSON.stringify(NFE.painel)); }catch(e){} }
function nfeRerender(){
  const pg = document.querySelector('nav.menu button.active')?.dataset.page;
  if(pg !== "gerencial" && (pg !== "emissaonf" || NF_ABA !== "nfe")) return;
  const foco = document.activeElement;
  if(foco && foco.closest && (foco.closest("#nfe-form") || foco.closest(".nfe-card") || foco.classList.contains("nfe-pg")) && /INPUT|SELECT|TEXTAREA/.test(foco.tagName)) return;
  const y = window.scrollY; document.getElementById("content").innerHTML = renderers[pg](); window.scrollTo(0,y);
  requestAnimationFrame(pg === "gerencial" ? nfgGrafico : nfeGrafico);
}
async function nfeGravarPainel(atividade, periodo, campos){
  const k = `${atividade}|${periodo}`, atual = NFE.painel[k] || {};
  const novo = { ...atual, ...campos, por:(MEU_EMAIL||"").split("@")[0], em:new Date().toISOString() };
  NFE.painel[k] = novo;
  if(sb){
    const { error } = await sb.from("nf_painel").upsert({ atividade, periodo, status:novo.status||null, obs:novo.obs||null, atualizado_por:MEU_EMAIL, atualizado_em:novo.em }, { onConflict:"atividade,periodo" });
    if(error){ toast("⚠ Não salvou o status: " + error.message); return false; }
  }
  nfeSalvarLocal(); return true;
}
/* ---------- Formulário ---------- */
function nfeLerForm(){ const g = (id)=>document.getElementById(id)?.value || ""; return { numero:g("nfe-numero"), balsa:g("nfe-balsa"), nf:g("nfe-nf"), valor:g("nfe-valor"), data:g("nfe-data"), obs:g("nfe-obs") }; }
function nfePreencher(d){ const s = (id,v)=>{ const el = document.getElementById(id); if(el && v!=null) el.value = v; }; s("nfe-numero", d.numero); s("nfe-balsa", d.balsa); s("nfe-nf", d.nf); s("nfe-valor", d.valor); s("nfe-data", d.data); s("nfe-obs", d.obs); }
function nfeRedesenhar(){ const d = nfeLerForm(); const y = window.scrollY; document.getElementById("content").innerHTML = renderers.emissaonf(); nfePreencher(d); window.scrollTo(0,y); requestAnimationFrame(nfeGrafico); }
window.nfeEscolherAtiv = (ch) => { NFE_ATIV = ch; if(!nfeAtiv(ch).sentido) NFE_SENTIDO = ""; NFE_PERIODO = nfePeriodoSugerido(ch); nfeRedesenhar(); };
window.nfeEscolherSentido = (s) => { NFE_SENTIDO = s; nfeRedesenhar(); };
window.nfeFiltro = (campo, v) => { NFE_FILTRO[campo] = v; nfeRerender(); };
window.nfeBuscar = (t) => { NFE_FILTRO.busca = t; nfeRerender(); const el = document.getElementById("nfe-busca"); if(el){ el.focus(); el.setSelectionRange(t.length,t.length); } };

window.nfeSalvar = async () => {
  const f = nfeLerForm(), valor = osNum("nfe-valor"), a = nfeAtiv(NFE_ATIV);
  const perSel = document.getElementById("nfe-periodo"); if(perSel) NFE_PERIODO = perSel.value;
  const pDe = document.getElementById("nfe-pde")?.value, pAte = document.getElementById("nfe-pate")?.value;
  if(a.periodoLivre){
    if(!pDe || !pAte){ toast("Informe o período: data inicial e data final."); return; }
    if(pAte < pDe){ toast("A data final do período está antes da inicial."); return; }
    NFE_PERIODO = `D:${pDe}:${pAte}`;
  }
  if(!NFE_ATIV){ toast("Escolha a atividade."); return; }
  if(a.sentido && !NFE_SENTIDO){ toast("Escolha o sentido: Subindo ou Descendo."); return; }
  if(a.cad && !a.semPeriodo && !NFE_PERIODO){ toast("Escolha o período a que a NF se refere."); return; }
  if(!f.nf.replace(/\D/g,"")){ toast("Informe o número da NF."); return; }
  if(!valor){ toast("Informe o valor."); return; }
  if(!f.data){ toast("Informe a data de emissão."); return; }
  const nf = progLimparNF(f.nf).replace(/^\/|\/$/g,"");
  if(NFE.lista.some(r=>r.nf===nf && r.id!==NFE_EDIT) && !confirm(`A NF ${nf} já está registrada. Registrar de novo?`)) return;
  const reg = { atividade:NFE_ATIV, sentido:a.sentido ? NFE_SENTIDO : "", periodo:a.cad && !a.semPeriodo ? NFE_PERIODO : "", numero:f.numero.trim(), balsa:nfeEhLR(NFE_ATIV) && f.balsa!=="__nova" ? f.balsa : "", nf, valor, dataEmissao:f.data, obs:f.obs.trim() };
  const banco = { atividade:reg.atividade, sentido:reg.sentido||null, periodo:reg.periodo||null, numero:reg.numero||null, ...(reg.balsa || NFE_EDIT ? { balsa:reg.balsa||null } : {}), nf:reg.nf, valor:reg.valor, data_emissao:reg.dataEmissao, obs:reg.obs||null,
    atualizado_por:MEU_EMAIL, atualizado_em:new Date().toISOString() };
  if(NFE_EDIT){
    if(sb){ const { error } = await sb.from("nf_emitidas").update(banco).eq("id", NFE_EDIT); if(error){ toast(/balsa/i.test(error.message) ? "⚠ Falta rodar o SQL do campo Balsa no Supabase." : "⚠ Não salvou: " + error.message); return; } }
    Object.assign(NFE.lista.find(r=>r.id===NFE_EDIT), reg);
    toast(`NF ${nf} atualizada ✓`);
  } else {
    const novo = { id:"tmp"+osNovoId(), ...reg, por:(MEU_EMAIL||"").split("@")[0] };
    if(sb){ const { data, error } = await sb.from("nf_emitidas").insert({ ...banco, criado_por:MEU_EMAIL }).select().single(); if(error){ toast(/balsa/i.test(error.message) ? "⚠ Falta rodar o SQL do campo Balsa no Supabase." : "⚠ Não salvou: " + error.message); return; } novo.id = data.id; }
    NFE.lista.unshift(novo);
    if(NFE_BALSA_ID){ await balVincularNF(NFE_BALSA_ID, novo.id); NFE_BALSA_ID = null; }
    if(NFE_OS_ID){ await oseVincularNF(NFE_OS_ID, novo); NFE_OS_ID = null; }
    toast(`NF ${nf} registrada ✓${reg.periodo ? " — painel atualizado 🟢" : ""}`);
  }
  nfeSalvarLocal();
  NFE_EDIT = null; NFE_SENTIDO = ""; NFE_PERIODO = nfePeriodoSugerido(NFE_ATIV);
  NFE_FILTRO.mes = reg.dataEmissao.slice(0,7);
  nfeRedesenhar(); nfePreencher({ numero:"", nf:"", valor:"", obs:"", data:reg.dataEmissao });
};
window.nfeEditar = (id) => {
  const r = NFE.lista.find(x=>x.id===id); if(!r) return;
  NFE_EDIT = id; NFE_ATIV = r.atividade; NFE_SENTIDO = r.sentido || ""; NFE_PERIODO = r.periodo || "";
  nfeRedesenhar();
  nfePreencher({ numero:r.numero, balsa:nfeBalsaDe(r), nf:r.nf, valor:"R$ "+r.valor.toLocaleString("pt-BR",{minimumFractionDigits:2, maximumFractionDigits:2}), data:r.dataEmissao, obs:r.obs });
  document.getElementById("nfe-form")?.scrollIntoView({ behavior:"smooth", block:"start" });
};
window.nfeCancelar = () => { NFE_EDIT = null; NFE_SENTIDO = ""; NFE_BALSA_ID = null; NFE_OS_ID = null; nfeRedesenhar(); nfePreencher({ numero:"", nf:"", valor:"", data:"", obs:"" }); };
window.nfeExcluir = async (id) => {
  const r = NFE.lista.find(x=>x.id===id); if(!r || !confirm(`Excluir a NF ${r.nf} (${nfeRotulo(r)} · ${fmtBRL2(r.valor)})?`)) return;
  if(sb){ const { error } = await sb.from("nf_emitidas").delete().eq("id", id); if(error){ toast("⚠ Não excluiu: " + error.message); return; } }
  NFE.lista = NFE.lista.filter(x=>x.id!==id); await balDesvincularNF(id); nfeSalvarLocal(); nfeRerender();
};

/* ---------- Controle de balsas (Logística Reversa SW e Carreteira) ----------
   Etapas de cada balsa até a receita: Abertura → Fechamento (pendente de documento) → Documento do cliente
   recebido (pendente de NF) → NF emitida (aguardando recebimento) → Recebida (NF com baixa de pagamento).
   A NF é lançada pelo formulário das NF Emitidas já ligada à balsa (coluna nf_id). Tabela: balsas_viagens. */
const BAL_LOCAL = "avance_balsas_local_v1";
const BAL_STATUS = {
  aberta:     { label:"Aberta",                               cor:"#2E6DB0", icone:"🔵" },
  pend_doc:   { label:"Pendente de documento",                cor:"#E1971F", icone:"🟠" },
  pend_nf:    { label:"Pendente de NF",                       cor:"#D0021B", icone:"🔴" },
  nf_emitida: { label:"NF emitida — aguardando recebimento",  cor:"#8E2EB0", icone:"🟣" },
  recebida:   { label:"Recebida",                             cor:"#1C9A6C", icone:"🟢" },
};
const BAL_ATIVS = [{ chave:"lr_sw", label:"Logística Reversa SW" }, { chave:"lr_carreteira", label:"Logística Reversa Carreteira" }];
let BAL = { lista:[], carregado:false, carregando:false, erro:null };
let BAL_FILTRO = "pendentes";      // pendentes | <status> | todas
// Listas de balsas e de semanas da manutenção: recolhidas por padrão (abre ao clicar ou ao escolher um status)
let BAL_ABERTO = false, MAN_ABERTO = false;
try{ BAL_ABERTO = localStorage.getItem("avance_bal_aberto")==="1"; MAN_ABERTO = localStorage.getItem("avance_man_aberto")==="1"; }catch(e){}
window.nfeAbrirLista = (qual, aberto) => { if(qual==="bal") BAL_ABERTO = aberto; else MAN_ABERTO = aberto; try{ localStorage.setItem(`avance_${qual}_aberto`, aberto ? "1" : "0"); }catch(e){} };
let BAL_ATIV = "lr_sw";
let NFE_BALSA_ID = null;           // balsa que a NF em lançamento vai quitar

function balNF(b){ return b.nfId ? NFE.lista.find(r=>r.id===b.nfId) : null; }
function balStatus(b){
  const nf = balNF(b);
  if(b.nfId) return nf && nf.dataPagamento ? "recebida" : "nf_emitida";
  if(b.dataDocumento) return "pend_nf";
  if(b.dataFechamento) return "pend_doc";
  return "aberta";
}
function balDesdeEtapa(b){
  const st = balStatus(b), nf = balNF(b);
  const ref = st==="aberta" ? b.dataAbertura : st==="pend_doc" ? b.dataFechamento : st==="pend_nf" ? b.dataDocumento : st==="nf_emitida" ? (nf ? nf.dataEmissao : "") : (nf ? nf.dataPagamento : "");
  return ref ? nfeDias(ref, frotaHojeISO()) : null;
}
function balNomes(){ return [...new Set([...nfBalsasConhecidas(), ...BAL.lista.map(b=>b.balsa), ...NFE.lista.map(r=>r.balsa)].filter(Boolean))].sort((a,b)=>a.localeCompare(b,"pt-BR")); }
const balRotulo = (b) => `${b.balsa}${b.numero ? " – " + b.numero : ""}`;

async function balCarregar(){
  BAL.carregando = true;
  if(!sb){ try{ BAL.lista = JSON.parse(localStorage.getItem(BAL_LOCAL)||"[]"); }catch(e){ BAL.lista = []; } }
  else {
    const { data, error } = await sb.from("balsas_viagens").select("*").order("data_abertura", { ascending:false });
    if(error){ BAL.erro = error.message; BAL.carregando = false; BAL.carregado = true; nfeRerender(); return; }
    BAL.erro = null;
    BAL.lista = data.map(r=>({ id:r.id, atividade:r.atividade, balsa:r.balsa, numero:r.numero||"", dataAbertura:r.data_abertura, dataFechamento:r.data_fechamento||"",
      dataDocumento:r.data_documento||"", nfId:r.nf_id||null, obs:r.obs||"", por:(r.atualizado_por||r.criado_por||"").split("@")[0] }));
  }
  BAL.carregando = false; BAL.carregado = true; nfeRerender();
}
function balSalvarLocal(){ if(!sb) try{ localStorage.setItem(BAL_LOCAL, JSON.stringify(BAL.lista)); }catch(e){} }
async function balAtualizar(b, campos){
  if(sb){ const { error } = await sb.from("balsas_viagens").update({ ...campos, atualizado_por:MEU_EMAIL, atualizado_em:new Date().toISOString() }).eq("id", b.id);
    if(error){ toast("⚠ Não salvou: " + error.message); return false; } }
  const mapa = { data_abertura:"dataAbertura", data_fechamento:"dataFechamento", data_documento:"dataDocumento", nf_id:"nfId", numero:"numero", obs:"obs" };
  Object.entries(campos).forEach(([k,v])=>{ b[mapa[k]||k] = v || (k==="nf_id" ? null : ""); });
  balSalvarLocal(); return true;
}

window.balSetAtiv = (a) => { BAL_ATIV = a; nfeRerender(); };
window.balFiltro = (f) => { BAL_FILTRO = BAL_FILTRO===f ? "pendentes" : f; nfeAbrirLista("bal", true); nfeRerender(); };
window.balAbrir = async () => {
  let balsa = document.getElementById("bal-nome")?.value || "";
  if(balsa === "__nova"){ balsa = (prompt("Nome da balsa:")||"").trim().toUpperCase(); }
  if(!balsa){ toast("Escolha a balsa."); return; }
  const numero = (document.getElementById("bal-num")?.value||"").trim(), data = document.getElementById("bal-data")?.value || frotaHojeISO();
  const b = { id:"tmp"+osNovoId(), atividade:BAL_ATIV, balsa, numero, dataAbertura:data, dataFechamento:"", dataDocumento:"", nfId:null, obs:"", por:(MEU_EMAIL||"").split("@")[0] };
  if(sb){ const { data:d, error } = await sb.from("balsas_viagens").insert({ atividade:b.atividade, balsa, numero:numero||null, data_abertura:data, criado_por:MEU_EMAIL, atualizado_por:MEU_EMAIL }).select().single();
    if(error){ toast("⚠ Não salvou: " + error.message); return; } b.id = d.id; }
  BAL.lista.unshift(b); balSalvarLocal(); toast(`Balsa ${balRotulo(b)} aberta ✓`); nfeRerender();
};
window.balAvancar = async (id, etapa) => {
  const b = BAL.lista.find(x=>x.id===id); if(!b) return;
  const data = document.getElementById(`bal-dt-${id}`)?.value || frotaHojeISO();
  if(etapa==="fechar"){ if(data < b.dataAbertura){ toast("O fechamento está antes da abertura."); return; } if(await balAtualizar(b, { data_fechamento:data })) toast(`${balRotulo(b)} fechada — pendente de documento 🟠`); }
  if(etapa==="documento"){ if(data < b.dataFechamento){ toast("O documento está antes do fechamento."); return; } if(await balAtualizar(b, { data_documento:data })) toast(`Documento recebido — ${balRotulo(b)} pendente de NF 🔴`); }
  nfeRerender();
};
window.balVoltar = async (id) => {
  const b = BAL.lista.find(x=>x.id===id); if(!b) return;
  const st = balStatus(b);
  const campos = st==="nf_emitida" || st==="recebida" ? { nf_id:null } : st==="pend_nf" ? { data_documento:null } : st==="pend_doc" ? { data_fechamento:null } : null;
  if(!campos) return;
  if(!confirm(`Voltar ${balRotulo(b)} uma etapa?${campos.nf_id===null ? " (a NF continua lançada, só deixa de estar ligada a esta balsa)" : ""}`)) return;
  await balAtualizar(b, campos); nfeRerender();
};
window.balData = async (id, campo, v) => {
  const b = BAL.lista.find(x=>x.id===id); if(!b) return;
  if(campo==="data_abertura" && !v && !b.nfId){ toast("A abertura é obrigatória enquanto a balsa não tem NF."); nfeRerender(); return; }
  const ab = campo==="data_abertura" ? v : b.dataAbertura, fe = campo==="data_fechamento" ? v : b.dataFechamento;
  if(ab && fe && fe < ab){ toast("O fechamento está antes da abertura."); nfeRerender(); return; }
  if(await balAtualizar(b, { [campo]: v || null })) toast("Data salva ✓");
  nfeRerender();
};
// Cria no controle uma balsa para cada NF de Logística Reversa já emitida que ainda não está ligada a nenhuma
// (balsa e nº vêm da NF; abertura e fechamento ficam em branco para preencher na tabela)
window.balTrazerNFs = async () => {
  const soltas = NFE.lista.filter(r=>nfeEhLR(r.atividade) && !BAL.lista.some(b=>b.nfId===r.id));
  if(!soltas.length){ toast("Todas as NFs de Logística Reversa já estão no controle."); return; }
  if(!confirm(`Trazer ${soltas.length} NF(s) de Logística Reversa já emitidas para o controle de balsas?\n\nCada uma vira uma balsa com status "NF emitida" (ou "Recebida", se já paga). Depois preencha a abertura e o fechamento na tabela.`)) return;
  const novas = soltas.map(r=>({ atividade:r.atividade, balsa:nfeBalsaDe(r) || "(sem balsa)", numero:r.numero||null, data_abertura:null, nf_id:r.id, obs:"trazida da NF já emitida", criado_por:MEU_EMAIL, atualizado_por:MEU_EMAIL }));
  if(sb){
    for(let i=0;i<novas.length;i+=50){
      const { error } = await sb.from("balsas_viagens").insert(novas.slice(i,i+50));
      if(error){ toast(/null value|not-null|data_abertura/i.test(error.message) ? "⚠ Falta rodar o SQL novo do controle de balsas no Supabase." : "⚠ Não salvou: " + error.message); return; }
    }
    await balCarregar();
  } else {
    novas.forEach(n=>BAL.lista.push({ id:"tmp"+osNovoId(), atividade:n.atividade, balsa:n.balsa, numero:n.numero||"", dataAbertura:"", dataFechamento:"", dataDocumento:"", nfId:n.nf_id, obs:n.obs }));
    balSalvarLocal(); nfeRerender();
  }
  toast(`✓ ${novas.length} NF(s) trazidas para o controle de balsas`);
};
window.balNumero = async (id, v) => { const b = BAL.lista.find(x=>x.id===id); if(b && await balAtualizar(b, { numero:v.trim() })) toast("Nº da balsa salvo ✓"); nfeRerender(); };
window.balExcluir = async (id) => {
  const b = BAL.lista.find(x=>x.id===id); if(!b || !confirm(`Excluir a balsa ${balRotulo(b)} do controle?`)) return;
  if(sb){ const { error } = await sb.from("balsas_viagens").delete().eq("id", id); if(error){ toast("⚠ Não excluiu: " + error.message); return; } }
  BAL.lista = BAL.lista.filter(x=>x.id!==id); balSalvarLocal(); nfeRerender();
};
// "Emitir NF": abre o formulário da NF já com a atividade e a balsa; ao registrar, a NF fica ligada à balsa
window.balEmitirNF = (id) => {
  const b = BAL.lista.find(x=>x.id===id); if(!b) return;
  NFE_EDIT = null; NFE_ATIV = b.atividade; NFE_SENTIDO = ""; NFE_PERIODO = ""; NFE_BALSA_ID = id;
  nfeRedesenhar(); nfePreencher({ balsa:b.balsa, numero:b.numero||"" });
  document.getElementById("nfe-form")?.scrollIntoView({ behavior:"smooth", block:"start" });
  setTimeout(()=>document.getElementById("nfe-nf")?.focus(), 400);
};
window.balCancelarVinculo = () => { NFE_BALSA_ID = null; nfeRedesenhar(); };
async function balVincularNF(balsaId, nfId){
  const b = BAL.lista.find(x=>x.id===balsaId); if(!b) return;
  if(await balAtualizar(b, { nf_id:nfId })) toast(`NF ligada à balsa ${balRotulo(b)} — foi para a receita a receber 🟣`);
}
async function balDesvincularNF(nfId){
  for(const b of BAL.lista.filter(x=>x.nfId===nfId)) await balAtualizar(b, { nf_id:null });
}

function balHTML(){
  if(!BAL.carregado && !BAL.carregando){ BAL.carregando = true; setTimeout(()=>balCarregar(), 0); }
  if(BAL.erro) return `<div class="panel" style="margin-bottom:16px;"><h3>🚢 Controle de balsas</h3><div class="os-alerta amber">⚠️ Não foi possível carregar o controle de balsas: ${osEsc(BAL.erro)}. Se falar em tabela inexistente ("balsas_viagens"), rode o SQL do controle de balsas no Supabase.</div></div>`;
  const comSt = BAL.lista.map(b=>({ b, st:balStatus(b) }));
  const cont = {}; Object.keys(BAL_STATUS).forEach(k=>cont[k] = comSt.filter(x=>x.st===k).length);
  const lista = comSt.filter(x=>BAL_FILTRO==="todas" || (BAL_FILTRO==="pendentes" ? x.st!=="recebida" : x.st===BAL_FILTRO))
    .sort((a,b)=>Object.keys(BAL_STATUS).indexOf(a.st)-Object.keys(BAL_STATUS).indexOf(b.st) || (a.b.dataAbertura||"").localeCompare(b.b.dataAbertura||""));
  const valorReceber = sumArr(comSt.filter(x=>x.st==="nf_emitida").map(x=>(balNF(x.b)||{}).valor||0));
  const hoje = frotaHojeISO();
  return `
    <div class="panel" style="margin-bottom:16px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">
        <div><h3 style="margin:0;">🚢 Controle de balsas — Logística Reversa</h3>
          <div class="hint">Abertura → fechamento → documento do cliente → NF → recebimento. Clique num status para filtrar a lista.</div></div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          ${(()=>{ const n = NFE.lista.filter(r=>nfeEhLR(r.atividade) && !BAL.lista.some(b=>b.nfId===r.id)).length; return n ? `<button class="os-btn sm green" onclick="balTrazerNFs()">🔄 Trazer ${n} NF(s) já emitidas</button>` : ""; })()}
          <button class="sub-tab-btn ${BAL_FILTRO==="todas"?"active":""}" onclick="balFiltro('todas')">Ver todas (${BAL.lista.length})</button>
        </div>
      </div>
      <div class="bal-sts">${Object.entries(BAL_STATUS).map(([k,s])=>`<button class="bal-st ${BAL_FILTRO===k?"sel":""}" style="--c:${s.cor};" onclick="balFiltro('${k}')">
        <span class="lbl">${s.icone} ${s.label}</span><b>${cont[k]}</b>${k==="nf_emitida" && valorReceber ? `<small>${fmtBRL(valorReceber)} a receber</small>` : ""}</button>`).join("")}</div>

      <div class="os-form bal-abrir">
        <div class="prog-chips">${BAL_ATIVS.map(a=>`<button type="button" class="sub-tab-btn ${BAL_ATIV===a.chave?"active":""}" onclick="balSetAtiv('${a.chave}')">${a.label}</button>`).join("")}</div>
        <div class="nf-grid" style="grid-template-columns:2fr 1fr 1fr auto; align-items:end;">
          <label>Balsa<select id="bal-nome"><option value="">Selecione</option>${balNomes().map(n=>`<option>${osEsc(n)}</option>`).join("")}<option value="__nova">+ outra balsa…</option></select></label>
          <label>Nº da balsa <small>(pode ficar em branco)</small><input id="bal-num" inputmode="numeric" placeholder="ex: 9252"></label>
          <label>Data de abertura<input type="date" id="bal-data" value="${hoje}"></label>
          <button class="entry-submit" style="margin:0;" onclick="balAbrir()">⚓ Abrir balsa</button>
        </div>
      </div>

      <details class="nfe-sum" ${BAL_ABERTO ? "open" : ""} ontoggle="nfeAbrirLista('bal', this.open)">
        <summary>Lista de balsas — <b>${lista.length}</b> ${BAL_FILTRO==="todas" ? "no total" : BAL_FILTRO==="pendentes" ? "pendente(s)" : "em " + BAL_STATUS[BAL_FILTRO].label}<span class="nfe-sum-dica"></span></summary>
      ${lista.length ? `<div style="overflow-x:auto; margin-top:8px;"><table class="nf-tab bal-tab">
        <thead><tr><th>Balsa</th><th>Nº</th><th>Atividade</th><th>Abertura</th><th>Fechamento</th><th>Documento</th><th>Status</th><th>Próxima etapa</th><th></th></tr></thead>
        <tbody>${lista.map(({b, st})=>{ const s = BAL_STATUS[st], nf = balNF(b), dias = balDesdeEtapa(b);
          const acao = st==="aberta" ? `<input type="date" id="bal-dt-${b.id}" value="${hoje}" class="nfe-pg"> <button class="os-btn sm" onclick="balAvancar('${b.id}','fechar')">🔒 Fechar balsa</button>`
            : st==="pend_doc" ? `<input type="date" id="bal-dt-${b.id}" value="${hoje}" class="nfe-pg"> <button class="os-btn sm" onclick="balAvancar('${b.id}','documento')">📄 Documento recebido</button>`
            : st==="pend_nf" ? `<button class="os-btn sm green" onclick="balEmitirNF('${b.id}')">🧾 Emitir NF</button>`
            : nf ? `NF <b>${osEsc(nf.nf)}</b> · ${fmtBRL2(nf.valor)} · emitida ${fmtDataBR(nf.dataEmissao)}${st==="recebida" ? ` · paga ${fmtDataBR(nf.dataPagamento)}` : ""}` : "NF não encontrada";
          return `<tr>
            <td><b>${osEsc(b.balsa)}</b></td>
            <td><input value="${osEsc(b.numero)}" placeholder="—" class="bal-num" inputmode="numeric" onchange="balNumero('${b.id}', this.value)"></td>
            <td style="font-size:12px;">${b.atividade==="lr_sw" ? "LR SW" : "LR Carreteira"}</td>
            <td><input type="date" class="nfe-pg bal-dt" value="${b.dataAbertura||""}" onchange="balData('${b.id}','data_abertura',this.value)"></td>
            <td>${st==="aberta" ? "—" : `<input type="date" class="nfe-pg bal-dt" value="${b.dataFechamento||""}" onchange="balData('${b.id}','data_fechamento',this.value)">`}</td><td>${b.dataDocumento ? fmtDataBR(b.dataDocumento) : "—"}</td>
            <td><span class="bal-badge" style="--c:${s.cor};">${s.icone} ${s.label}</span>${dias!=null && st!=="recebida" ? `<div class="hint" style="margin:2px 0 0;">há ${dias} dia(s) nesta etapa</div>` : ""}</td>
            <td style="white-space:nowrap;">${acao}</td>
            <td style="white-space:nowrap;">${st!=="aberta" ? `<button class="os-link" onclick="balVoltar('${b.id}')" title="Voltar uma etapa">↩</button>` : ""} <button class="os-link" onclick="balExcluir('${b.id}')" title="Excluir">🗑️</button></td>
          </tr>`; }).join("")}</tbody>
      </table></div>` : `<div class="empty-state" style="padding:16px;"><p>${BAL.carregando ? "Carregando..." : "Nenhuma balsa neste filtro."}</p></div>`}
      </details>
    </div>`;
}

// Dias entre duas datas ISO (lead time de pagamento e idade das pendentes)
function nfeDias(de, ate){ return Math.round((nfeDate(ate) - nfeDate(de)) / 864e5); }
const nfePodeBaixar = () => MEU_PAPEL === "diretor";   // a baixa do recebimento é da Diretoria
window.nfeBaixar = async (id, inputId) => {
  if(!nfePodeBaixar()){ toast("A baixa do recebimento é feita pela Diretoria."); return; }
  const r = NFE.lista.find(x=>x.id===id); if(!r) return;
  const data = document.getElementById(inputId || `nfe-pg-${id}`)?.value || frotaHojeISO();
  if(data < r.dataEmissao && !confirm("A data de pagamento é anterior à emissão. Confirmar assim mesmo?")) return;
  if(sb){ const { error } = await sb.from("nf_emitidas").update({ data_pagamento:data, atualizado_por:MEU_EMAIL, atualizado_em:new Date().toISOString() }).eq("id", id);
    if(error){ toast(/data_pagamento/i.test(error.message) ? "⚠ Falta rodar o SQL da baixa de pagamento no Supabase." : /diretoria/i.test(error.message) ? "⚠ A baixa do recebimento é feita pela Diretoria." : "⚠ Não salvou: " + error.message); return; } }
  r.dataPagamento = data; nfeSalvarLocal();
  toast(`NF ${r.nf} baixada como paga em ${fmtDataBR(data)} · lead time ${nfeDias(r.dataEmissao, data)} dias ✓`); nfeRerender();
};
window.nfeEstornar = async (id) => {
  if(!nfePodeBaixar()){ toast("Somente a Diretoria pode desfazer a baixa."); return; }
  const r = NFE.lista.find(x=>x.id===id); if(!r || !confirm(`Desfazer a baixa da NF ${r.nf}? Ela volta para as pendentes.`)) return;
  if(sb){ const { error } = await sb.from("nf_emitidas").update({ data_pagamento:null, atualizado_por:MEU_EMAIL, atualizado_em:new Date().toISOString() }).eq("id", id); if(error){ toast("⚠ Não salvou: " + error.message); return; } }
  r.dataPagamento = ""; nfeSalvarLocal(); nfeRerender();
};

// Logística Reversa (SW e Carreteira): a NF tem o campo Balsa e o período vem da balsa ligada a ela
function nfeEhLR(ch){ return ch==="lr_sw" || ch==="lr_carreteira"; }
// Balsa da NF: o campo próprio; senão a balsa ligada no controle; senão o nome que estava na observação
function nfeBalsaDe(r){
  if(r.balsa) return r.balsa;
  const b = (typeof BAL!=="undefined") && BAL.lista.find(x=>x.nfId===r.id); if(b) return b.balsa;
  if(!nfeEhLR(r.atividade) || !r.obs) return "";
  const o = nfSemAcento(r.obs);
  const conhecida = balNomes().find(n=>{ const s = nfSemAcento(n); return o===s || o.startsWith(s+" ") || o.startsWith(s+"-"); });
  if(conhecida) return conhecida;
  // nas logísticas reversas a observação costuma ser o próprio nome da balsa (ex: "ISABELLE")
  const txt = r.obs.trim().toUpperCase(); return txt.length <= 25 && /^[A-ZÀ-Ú][A-ZÀ-Ú0-9 .\-]*$/.test(txt) ? txt : "";
}
// Período da NF: nas logísticas reversas, abertura a fechamento da balsa ligada
function nfePeriodoNF(r){
  if(nfeEhLR(r.atividade)){
    const b = BAL.lista.find(x=>x.nfId===r.id);
    if(b && (b.dataAbertura || b.dataFechamento)) return `${b.dataAbertura ? nfeBR(b.dataAbertura) : "?"} a ${b.dataFechamento ? nfeBR(b.dataFechamento) : "?"}`;
    return "—";
  }
  return nfeRotuloPeriodo(r);
}

function nfeFiltradas(){
  const busca = nfSemAcento(NFE_FILTRO.busca);
  // Pendentes aparecem de qualquer mês de emissão (o que importa é estar em aberto); pagas e "todas" seguem o mês
  return NFE.lista.filter(r=>(NFE_FILTRO.sit==="todas" || (NFE_FILTRO.sit==="pagas" ? !!r.dataPagamento : !r.dataPagamento))
    && (NFE_FILTRO.sit==="pendentes" || NFE_FILTRO.mes==="todos" || (r.dataEmissao||"").startsWith(NFE_FILTRO.mes))
    && (NFE_FILTRO.atividade==="todas" || r.atividade===NFE_FILTRO.atividade)
    && (!busca || nfSemAcento(`${r.nf} ${r.numero} ${r.obs} ${nfeRotulo(r)}`).includes(busca)));
}
function nfeRotuloPeriodo(r){ if(r.periodo && r.periodo.startsWith("D:")){ const [, i, f] = r.periodo.split(":"); return `${nfeBR(i)} a ${nfeBR(f)}`; } const a = nfeAtiv(r.atividade); const p = a.cad && r.periodo ? nfePeriodoPorChave(a.cad, r.periodo) : null; return p ? p.rotulo : "—"; }

function nfePagina(){
  if(!NFE.carregado && !NFE.carregando){ NFE.carregando = true; setTimeout(()=>nfeCarregar(), 0); }
  if(NFE_OS_ID) oseGarantirCarga();
  if(NFE.erro) return `<div class="panel"><div class="empty-state" style="padding:24px;"><div class="glyph">⚠️</div><h4>Não foi possível carregar as NF emitidas</h4><p>${osEsc(NFE.erro)}</p><p>Se falar em tabela inexistente ("nf_emitidas") ou coluna "periodo", rode o SQL das NF Emitidas no Supabase.</p></div></div>`;
  const meses = [...new Set(NFE.lista.map(r=>(r.dataEmissao||"").slice(0,7)).filter(Boolean))].sort().reverse();
  const hojeMes = frotaHojeISO().slice(0,7);
  if(!NFE_FILTRO.mes) NFE_FILTRO.mes = hojeMes;
  if(!meses.includes(hojeMes)) meses.unshift(hojeMes);
  const nomeMes = (m) => m==="todos" ? "Todos os meses" : nfeNomeMes(m);
  const opt = (v,l,a) => `<option value="${v}" ${v===a?"selected":""}>${osEsc(l)}</option>`;
  const doMes = NFE.lista.filter(r=>NFE_FILTRO.mes==="todos" || (r.dataEmissao||"").startsWith(NFE_FILTRO.mes));
  const lista = nfeFiltradas().sort((a,b)=>(b.dataEmissao||"").localeCompare(a.dataEmissao||"") || (b.nf||"").localeCompare(a.nf||""));
  const total = sumArr(doMes.map(r=>r.valor));
  const a = nfeAtiv(NFE_ATIV);
  const perOpcoes = a.cad ? nfePeriodos(a.cad) : [];
  if(a.cad && NFE_PERIODO && !perOpcoes.some(p=>p.chave===NFE_PERIODO)){ const extra = nfePeriodoPorChave(a.cad, NFE_PERIODO); if(extra) perOpcoes.push(extra); }
  return `
    ${balHTML()}
    ${manHTML()}

    <div class="panel os-form" id="nfe-form" style="margin-bottom:16px; ${NFE_EDIT ? "border:2px solid var(--amber);" : ""}">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
        <h3 style="margin:0;">${NFE_EDIT ? "✏️ Editando NF" : "➕ Registrar NF emitida"}</h3>
        ${NFE_EDIT ? `<button class="os-btn" onclick="nfeCancelar()">Cancelar edição</button>` : ""}
      </div>
      <label style="margin-top:10px;">Atividade</label>
      <div class="prog-chips">${NFE_ATIVIDADES.filter(x=>!x.oculto).map(x=>`<button type="button" class="sub-tab-btn nfe-chip ${NFE_ATIV===x.chave?"active":""}" style="--c:${x.cor};" onclick="nfeEscolherAtiv('${x.chave}')">${x.label}</button>`).join("")}</div>
      ${a.sentido ? `<div class="prog-chips"><span class="hint" style="margin:0;">Sentido:</span>
        <button type="button" class="sub-tab-btn ${NFE_SENTIDO==="sobe"?"active":""}" onclick="nfeEscolherSentido('sobe')">⬆️ Subindo</button>
        <button type="button" class="sub-tab-btn ${NFE_SENTIDO==="desce"?"active":""}" onclick="nfeEscolherSentido('desce')">⬇️ Descendo</button></div>` : ""}
      ${a.periodoLivre ? (()=>{ const pc = !(NFE_PERIODO||"").startsWith("D:") && NFE_PERIODO && a.cad ? nfePeriodoPorChave(a.cad, NFE_PERIODO) : null;   // NF antiga com período fechado (ex: mês)
        const [, i, f] = (NFE_PERIODO||"").startsWith("D:") ? NFE_PERIODO.split(":") : pc ? ["", pc.ini, pc.fim] : ["","",""]; return `<div class="nf-grid" style="grid-template-columns:repeat(2,minmax(150px,220px));"><label>Período — de<input type="date" id="nfe-pde" value="${i}"></label><label>até<input type="date" id="nfe-pate" value="${f}"></label></div>`; })() : ""}
      ${a.cad && !a.semPeriodo && !a.periodoLivre ? `<label>Período (o que a NF fatura)<select id="nfe-periodo" onchange="NFE_PERIODO=this.value">
        <option value="">Selecione</option>${perOpcoes.map(p=>{ const st = nfeStatus(a.chave, p); return `<option value="${p.chave}" ${p.chave===NFE_PERIODO?"selected":""}>${({vermelho:"🔴",amarelo:"🟡",verde:"🟢",cinza:"⚪"})[st.cor]} ${osEsc(p.rotulo)} — prazo ${nfeBR(p.prazo)}</option>`; }).join("")}
      </select></label>` : ""}
      <div class="nf-grid">
        <label>${nfeEhLR(NFE_ATIV) ? "Nº da balsa" : "Número"}<input id="nfe-numero" inputmode="numeric" placeholder="${nfeEhLR(NFE_ATIV) ? "ex: 9252" : "contrato / O.S / viagem"}" oninput="nfLimparDigitos(this,'/\\-')"></label>
        ${nfeEhLR(NFE_ATIV) ? `<label>Balsa<select id="nfe-balsa" onchange="if(this.value==='__nova'){ const n=(prompt('Nome da balsa:')||'').trim().toUpperCase(); if(n){ const o=document.createElement('option'); o.text=n; o.value=n; this.add(o, this.options.length-1); this.value=n; } else this.value=''; }"><option value="">Selecione</option>${balNomes().map(n=>`<option>${osEsc(n)}</option>`).join("")}<option value="__nova">+ outra balsa…</option></select></label>` : ""}
        <label>NF<input id="nfe-nf" inputmode="numeric" placeholder="ex: 1234 ou 1234/1235" oninput="progNF(this)"></label>
        <label>Valor<input id="nfe-valor" inputmode="numeric" placeholder="R$ 0,00" oninput="osMascaraBRL(this)"></label>
        <label>Data de emissão<input type="date" id="nfe-data" value="${frotaHojeISO()}"></label>
      </div>
      ${NFE_OS_ID ? (()=>{ const o = OSE.lista.find(x=>x.id===NFE_OS_ID); return o ? `<div class="os-alerta amber">🧾 Esta NF fecha a <b>O.S ${oseNum(o.numero)}</b> (frota ${osEsc(o.frota)} · ${fmtBRL2(oseValor(o))}). Ao registrar, a O.S fica com a NF. <button class="os-link" onclick="oseCancelarVinculoNF()">não ligar</button></div>` : ""; })() : ""}
      ${NFE_BALSA_ID ? (()=>{ const b = BAL.lista.find(x=>x.id===NFE_BALSA_ID); return b ? `<div class="os-alerta amber">🚢 Esta NF vai quitar a balsa <b>${osEsc(balRotulo(b))}</b> (${b.atividade==="lr_sw" ? "LR SW" : "LR Carreteira"}). <button class="os-link" onclick="balCancelarVinculo()">não ligar</button></div>` : ""; })() : ""}
      <label>Observação<input id="nfe-obs" placeholder="opcional"></label>
      <button class="entry-submit" onclick="nfeSalvar()">${NFE_EDIT ? "Salvar alterações" : "Registrar NF"}</button>
    </div>

    <div class="panel" style="margin-bottom:16px;">
      <div class="filtro-bar">
        <label>Mês de emissão<select onchange="nfeFiltro('mes',this.value)">${opt("todos","Todos os meses",NFE_FILTRO.mes)}${meses.map(m=>opt(m, nomeMes(m), NFE_FILTRO.mes)).join("")}</select></label>
        <label>Atividade<select onchange="nfeFiltro('atividade',this.value)">${opt("todas","Todas",NFE_FILTRO.atividade)}${NFE_VISIVEIS().map(x=>opt(x.chave,x.label,NFE_FILTRO.atividade)).join("")}</select></label>
        <label>Situação<select onchange="nfeFiltro('sit',this.value)">${opt("pendentes","Pendentes (a receber)",NFE_FILTRO.sit)}${opt("pagas","Pagas",NFE_FILTRO.sit)}${opt("todas","Todas",NFE_FILTRO.sit)}</select></label>
        <label>Buscar<input id="nfe-busca" value="${osEsc(NFE_FILTRO.busca)}" placeholder="NF, número ou observação" oninput="nfeBuscar(this.value)"
          style="font-family:inherit; font-size:13px; padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:var(--paper);"></label>
      </div>
    </div>

    <div class="panel" style="margin-bottom:16px;">
      <h3>Emitido por atividade — ${nomeMes(NFE_FILTRO.mes)}</h3>
      ${(()=>{ const pagas = doMes.filter(r=>r.dataPagamento), vPago = sumArr(pagas.map(r=>r.valor)), vAberto = total - vPago;
        return `<div class="os-resumo prog-resumo nfe-tot" style="margin:6px 0 10px;">
          <div>Emitido no período<b>${fmtBRL2(total)}</b><small>${doMes.length} NF(s)</small></div>
          <div>Pago<b style="color:var(--green);">${fmtBRL2(vPago)}</b><small>${pagas.length} NF(s) já pagas</small></div>
          <div>A receber<b style="color:var(--${vAberto>0.005?"amber":"green"});">${fmtBRL2(vAberto)}</b><small>${doMes.length-pagas.length} NF(s) em aberto</small></div>
          <div>% recebido<b>${total ? (vPago/total*100).toFixed(1).replace(".",",") : "0"}%</b><small>do valor emitido no período</small></div>
        </div>`; })()}
      <div class="hint">Período pela data de emissão (filtro "Mês de emissão" acima). Clique numa atividade para filtrar a lista.</div>
      <div class="frota-ativs">${NFE_VISIVEIS().map(x=>{ const ls = doMes.filter(r=>r.atividade===x.chave), v = sumArr(ls.map(r=>r.valor));
        const sobe = ls.filter(r=>r.sentido==="sobe").length, desce = ls.filter(r=>r.sentido==="desce").length;
        return `<button class="frota-ativ ${NFE_FILTRO.atividade===x.chave?"sel":""}" style="--c:${x.cor};" onclick="nfeFiltro('atividade','${NFE_FILTRO.atividade===x.chave?"todas":x.chave}')">
          <span class="frota-ativ-lbl">${x.label}</span><span class="frota-ativ-qtd" style="font-size:22px;">${fmtBRL(v)}</span>
          <span class="frota-ativ-sub">${ls.length} NF(s)${x.sentido && ls.length ? ` · ⬆️ ${sobe} · ⬇️ ${desce}` : ""}${total ? ` · ${(v/total*100).toFixed(0)}%` : ""}</span>${ls.length ? `<span class="frota-ativ-sub">💵 pago ${fmtBRL(sumArr(ls.filter(r=>r.dataPagamento).map(r=>r.valor)))}${ls.some(r=>!r.dataPagamento) ? ` · a receber ${fmtBRL(sumArr(ls.filter(r=>!r.dataPagamento).map(r=>r.valor)))}` : " ✓"}</span>` : ""}</button>`; }).join("")}</div>
      <div class="chart-wrap" style="height:${NFE_FILTRO.mes==="todos" ? 280 : 0}px; ${NFE_FILTRO.mes==="todos" ? "" : "display:none;"} margin-top:14px;"><canvas id="ch-nfe"></canvas></div>
    </div>

    <div class="panel">
      <h3>${({ pendentes:"NF pendentes de pagamento", pagas:"NF pagas", todas:"NF emitidas" })[NFE_FILTRO.sit]} (${lista.length})</h3>
      ${(()=>{ const hoje = frotaHojeISO(), pend = NFE.lista.filter(r=>!r.dataPagamento), pagas = NFE.lista.filter(r=>r.dataPagamento);
        const pagasMes = pagas.filter(r=>r.dataPagamento.startsWith(hoje.slice(0,7)));
        const lt = pagas.filter(r=>nfeDias(r.dataPagamento, hoje) <= 90).map(r=>nfeDias(r.dataEmissao, r.dataPagamento));
        const maisAntiga = pend.reduce((m,r)=>!m || r.dataEmissao < m.dataEmissao ? r : m, null);
        return `<div class="os-resumo prog-resumo" style="margin:6px 0 12px;">
          <div>A receber (pendentes)<b style="color:var(--amber);">${fmtBRL(sumArr(pend.map(r=>r.valor)))}</b><small>${pend.length} NF(s) · todos os meses</small></div>
          <div>Pago neste mês<b style="color:var(--green);">${fmtBRL(sumArr(pagasMes.map(r=>r.valor)))}</b><small>${pagasMes.length} NF(s) baixadas</small></div>
          <div>Lead time médio<b>${lt.length ? Math.round(sumArr(lt)/lt.length) + " dias" : "—"}</b><small>emissão → pagamento · últimos 90 dias</small></div>
          <div>Pendente mais antiga<b style="color:var(--${maisAntiga && nfeDias(maisAntiga.dataEmissao, hoje) > 30 ? "red" : "ink"});">${maisAntiga ? nfeDias(maisAntiga.dataEmissao, hoje) + " dias" : "—"}</b><small>${maisAntiga ? `NF ${osEsc(maisAntiga.nf)} · ${fmtDataBR(maisAntiga.dataEmissao)}` : "nenhuma em aberto"}</small></div>
        </div>`; })()}
      ${lista.length ? `<div style="overflow-x:auto;"><table class="nf-tab">
        <thead><tr><th>Atividade</th><th>Período</th><th>Número</th><th>Balsa</th><th>NF</th><th class="num">Valor</th><th>Data de emissão</th><th>Observação</th><th>Pagamento</th><th></th></tr></thead>
        <tbody>${lista.map(r=>`<tr ${NFE_EDIT===r.id?'style="background:#FCF1DE;"':""}>
          <td><span class="nfe-dot" style="--c:${nfeAtiv(r.atividade).cor};"></span>${osEsc(nfeRotulo(r))}</td>
          <td style="font-size:12px;">${osEsc(nfePeriodoNF(r))}</td>
          <td>${osEsc(r.numero)||"—"}</td><td>${nfeBalsaDe(r) ? `🚢 ${osEsc(nfeBalsaDe(r))}` : "—"}</td><td><b>${osEsc(r.nf)}</b></td><td class="num"><b>${fmtBRL2(r.valor)}</b></td>
          <td>${fmtDataBR(r.dataEmissao)}</td><td>${osEsc(r.obs)||"—"}</td>
          <td style="white-space:nowrap;">${r.dataPagamento
            ? `<span class="badge green">✓ pago ${fmtDataBR(r.dataPagamento)}</span> <span class="hint" style="margin:0;">${nfeDias(r.dataEmissao, r.dataPagamento)} dias</span>${nfePodeBaixar() ? ` <button class="os-link" onclick="nfeEstornar('${r.id}')" title="Desfazer baixa">desfazer</button>` : ""}`
            : nfeBaixaHTML(r)}</td>
          <td style="white-space:nowrap;"><button class="os-link" onclick="nfeEditar('${r.id}')" title="Editar">✏️</button> <button class="os-link" onclick="nfeExcluir('${r.id}')" title="Excluir">🗑️</button></td>
        </tr>`).join("")}</tbody>
        <tfoot><tr style="font-weight:800; background:var(--paper);"><td colspan="5">Total</td><td class="num">${fmtBRL2(sumArr(lista.map(r=>r.valor)))}</td><td colspan="4"></td></tr></tfoot>
      </table></div>` : `<div class="empty-state" style="padding:18px;"><p>${NFE.carregando ? "Carregando..." : "Nenhuma NF com esses filtros."}</p></div>`}
    </div>`;
}

// Com "Todos os meses": colunas empilhadas por mês e atividade
function nfeGrafico(){
  const el = document.getElementById("ch-nfe"); if(!el || NFE_FILTRO.mes!=="todos") return;
  const meses = [...new Set(NFE.lista.map(r=>(r.dataEmissao||"").slice(0,7)).filter(Boolean))].sort();
  mkChart("ch-nfe", {
    type:"bar",
    data:{ labels:meses.map(nfeNomeMes), datasets:NFE_VISIVEIS().map(x=>({
      label:x.label, data:meses.map(m=>sumArr(NFE.lista.filter(r=>r.atividade===x.chave && (r.dataEmissao||"").startsWith(m)).map(r=>r.valor))),
      backgroundColor:x.cor, stack:"a", borderColor:"#fff", borderWidth:{ top:2 }, borderRadius:4, maxBarThickness:52 })) },
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ position:"bottom", labels:{ boxWidth:10, usePointStyle:true, pointStyle:"rectRounded" } }, datalabels:{ display:false },
        tooltip:{ mode:"index", filter:(it)=>it.raw>0, callbacks:{ label:(c)=>` ${c.dataset.label}: ${fmtBRL(c.raw)}` } } },
      scales:{ x:{ stacked:true, grid:{ display:false } }, y:{ stacked:true, grid:{ color:COLORS.grid }, ticks:{ callback:v=>fmtMil(v) } } } }
  });
}

/* -------------------- MANUTENÇÃO DE CARRETA — CICLO SEMANAL (contrato Combitrans) --------------------
   Cada semana de manutenção segue as etapas do contrato:
     Semana 1       execução das manutenções
     Semana 2       documento das frotas mantidas → administrativo da Avance → checagem → O.S para a Combitrans
     O.S + 7 dias   a Combitrans analisa e devolve a O.S assinada
     Semana 4       a Avance emite a NF (período = a semana) → a Combitrans paga em até 15 dias da emissão
   As datas de cada etapa ficam na tabela manut_ciclos (uma linha por semana, chave = segunda-feira).
   A NF é a das NF Emitidas (Manutenção de Carreta) cujo período cobre a semana. */
const MAN_LOCAL = "avance_manut_ciclos_v1";
const MAN_PRAZO_PGTO = 15;   // dias da emissão da NF até o pagamento da Combitrans
const MAN_ETAPAS = {
  execucao:   { label:"Semana 1 · em execução",               cor:"#2E6DB0", icone:"🔧" },
  pend_doc:   { label:"Pendente de documento (adm.)",         cor:"#E1971F", icone:"📄" },
  pend_os:    { label:"Pendente de O.S p/ Combitrans",        cor:"#C77700", icone:"🧾" },
  assinatura: { label:"Combitrans analisando / aprovação",    cor:"#B8860B", icone:"✍️" },
  pend_nf:    { label:"Pendente de NF",                       cor:"#D0021B", icone:"🔴" },
  nf_emitida: { label:"NF emitida — aguardando pagamento",    cor:"#8E2EB0", icone:"🟣" },
  recebida:   { label:"Recebida",                             cor:"#1C9A6C", icone:"🟢" },
  sem_op:     { label:"Sem manutenção na semana",             cor:"#9A9CA6", icone:"⚪" },
};
const MAN_CAMPO = { documento:"dataDocumento", os:"dataOS", assinatura:"dataAssinatura" };
let MAN = { ciclos:{}, carregado:false, carregando:false, erro:null };
let MAN_FILTRO = "pendentes";   // pendentes | <etapa> | todas

// Segundas-feiras do início do controle até a semana atual (mais recente primeiro)
function manSemanas(){
  const hoje = frotaHojeISO(), l = []; let s = nfeSegunda(NFE_INICIO_CONTROLE);
  while(s <= hoje && l.length < 120){ l.push(s); s = nfeAddDias(s, 7); }
  return l.reverse();
}
function manNFs(ini){ const p = { chave:`S:${ini}`, ini, fim:nfeAddDias(ini, 6) }, a = nfeAtiv("manutencao"); return NFE.lista.filter(r=>r.atividade==="manutencao" && nfeCobre(r, p, a)); }
function manCiclo(ini){
  const c = MAN.ciclos[ini] || {}, hoje = frotaHojeISO(), fim = nfeAddDias(ini, 6), nfs = manNFs(ini);
  let st, prazo = null;
  if(nfs.length){ st = nfs.every(r=>r.dataPagamento) ? "recebida" : "nf_emitida"; prazo = nfs.filter(r=>!r.dataPagamento).map(r=>nfeAddDias(r.dataEmissao, MAN_PRAZO_PGTO)).sort()[0] || null; }
  else if(c.semOperacao) st = "sem_op";
  else if(hoje <= fim){ st = "execucao"; prazo = fim; }
  else if(!c.dataDocumento){ st = "pend_doc"; prazo = nfeAddDias(ini, 13); }   // dentro da semana 2
  else if(!c.dataOS){ st = "pend_os"; prazo = nfeAddDias(ini, 13); }          // na mesma semana 2
  else if(!c.dataAssinatura){ st = "assinatura"; prazo = nfeAddDias(c.dataOS, 7); }
  else { st = "pend_nf"; prazo = nfeAddDias(ini, 27); }                      // até o fim da semana 4
  const atrasado = !!prazo && hoje > prazo && !["recebida","sem_op","execucao"].includes(st);
  return { ini, fim, c, nfs, st, prazo, atrasado, diasAtraso: atrasado ? nfeDias(prazo, hoje) : 0 };
}
function manCiclos(){ return manSemanas().map(manCiclo); }

async function manCarregar(){
  MAN.carregando = true;
  if(!sb){ try{ MAN.ciclos = JSON.parse(localStorage.getItem(MAN_LOCAL)||"{}"); }catch(e){ MAN.ciclos = {}; } }
  else {
    const { data, error } = await sb.from("manut_ciclos").select("*");
    if(error) MAN.erro = error.message;
    else { MAN.erro = null; MAN.ciclos = {};
      data.forEach(r=>{ MAN.ciclos[r.semana] = { dataDocumento:r.data_documento||"", dataOS:r.data_os||"", dataAssinatura:r.data_assinatura||"", semOperacao:!!r.sem_operacao, obs:r.obs||"",
        osNumero:r.os_numero||"", osValor:r.os_valor!=null ? Number(r.os_valor) : null, osValorAprovado:r.os_valor_aprovado!=null ? Number(r.os_valor_aprovado) : null, por:(r.atualizado_por||"").split("@")[0] }; }); }
  }
  MAN.carregando = false; MAN.carregado = true; nfeRerender();
}
function manGarantirCarga(){ if(!MAN.carregado && !MAN.carregando){ MAN.carregando = true; setTimeout(()=>manCarregar(), 0); } }
async function manGravar(ini, campos){
  const novo = { ...(MAN.ciclos[ini] || {}), ...campos };
  if(sb){
    const { error } = await sb.from("manut_ciclos").upsert({ semana:ini, data_documento:novo.dataDocumento||null, data_os:novo.dataOS||null, data_assinatura:novo.dataAssinatura||null,
      sem_operacao:!!novo.semOperacao, obs:novo.obs||null, atualizado_por:MEU_EMAIL,
      ...(novo.osNumero || novo.osValor || novo.osValorAprovado || MAN.ciclos[ini]?.osNumero ? { os_numero:novo.osNumero||null, os_valor:novo.osValor||null, os_valor_aprovado:novo.osValorAprovado||null } : {}), atualizado_em:new Date().toISOString() }, { onConflict:"semana" });
    if(error){ toast(/manut_ciclos/i.test(error.message) ? "⚠ Falta rodar o SQL do ciclo da Manutenção de Carreta no Supabase." : /os_numero|os_valor/i.test(error.message) ? "⚠ Falta rodar o SQL do registro da O.S (nº e valor) no Supabase." : "⚠ Não salvou: " + error.message); return false; }
  }
  MAN.ciclos[ini] = novo; if(!sb) try{ localStorage.setItem(MAN_LOCAL, JSON.stringify(MAN.ciclos)); }catch(e){}
  return true;
}
window.manAvancar = async (ini, etapa) => {
  const v = document.getElementById(`man-dt-${ini}`)?.value || frotaHojeISO();
  const c = MAN.ciclos[ini] || {}, campos = { [MAN_CAMPO[etapa]]:v };
  if(etapa==="os"){
    const num = (document.getElementById(`man-osn-${ini}`)?.value||"").trim(), val = osNum(`man-osv-${ini}`);
    if(!num){ toast("Informe o nº de controle da O.S."); return; }
    if(!val){ toast("Informe o valor total da O.S."); return; }
    if(c.dataDocumento && v < c.dataDocumento){ toast("A O.S está antes do envio do documento."); return; }
    campos.osNumero = num; campos.osValor = val;
    if(!c.dataDocumento) campos.dataDocumento = v;   // o documento seguiu junto com a O.S
  }
  if(etapa==="assinatura"){
    if(c.dataOS && v < c.dataOS){ toast("A aprovação está antes da emissão da O.S."); return; }
    campos.osValorAprovado = osNum(`man-osa-${ini}`) || c.osValor || null;
  }
  if(await manGravar(ini, campos)) toast(({ documento:"Documento enviado ao administrativo ✓", os:`O.S ${campos.osNumero||""} registrada ✓`, assinatura:"O.S aprovada pela Combitrans ✓" })[etapa]);
  nfeRerender();
};
// Corrige nº / valor da O.S direto na tabela
window.manOSCampo = async (ini, campo, el) => {
  const v = campo==="osNumero" ? el.value.trim() : (()=>{ const t = el.value.replace(/[R$\s]/g,""); const n = parseFloat(t.includes(",") ? t.replace(/\./g,"").replace(",",".") : t); return isNaN(n) ? null : n; })();
  if(await manGravar(ini, { [campo]:v })) toast("O.S atualizada ✓");
};
window.manData = async (ini, etapa, v) => { if(await manGravar(ini, { [MAN_CAMPO[etapa]]:v||"" })) toast("Data salva ✓"); nfeRerender(); };
window.manSemOp = async (ini, v) => { if(v && !confirm(`Marcar a semana ${nfeBR(ini)} a ${nfeBR(nfeAddDias(ini,6))} como SEM manutenção?`)) return; if(await manGravar(ini, { semOperacao:v })) nfeRerender(); };
window.manVoltar = async (ini) => {
  const c = MAN.ciclos[ini] || {}, campo = c.dataAssinatura ? "dataAssinatura" : c.dataOS ? "dataOS" : c.dataDocumento ? "dataDocumento" : null;
  if(!campo || !confirm("Voltar uma etapa (apaga a última data lançada)?")) return;
  if(await manGravar(ini, { [campo]:"" })) nfeRerender();
};
window.manEmitirNF = (ini) => {
  NF_ABA = "nfe"; NFE_EDIT = null; NFE_BALSA_ID = null; NFE_ATIV = "manutencao"; NFE_SENTIDO = ""; NFE_PERIODO = `D:${ini}:${nfeAddDias(ini, 6)}`;
  const c = MAN.ciclos[ini] || {}, val = c.osValorAprovado || c.osValor;
  navigate("emissaonf");
  setTimeout(()=>{ nfePreencher({ valor: val ? "R$ " + val.toLocaleString("pt-BR", { minimumFractionDigits:2, maximumFractionDigits:2 }) : "", obs: c.osNumero ? `O.S Combitrans nº ${c.osNumero}` : "" });
    document.getElementById("nfe-form")?.scrollIntoView({ behavior:"smooth", block:"start" }); }, 60);
};
window.manFiltro = (f) => { MAN_FILTRO = MAN_FILTRO===f ? "pendentes" : f; nfeAbrirLista("man", true); nfeRerender(); };

// Tabela das semanas (usada no bloco do ciclo e no detalhe do Painel Gerencial)
function manTabela(lista){
  if(!lista.length) return `<div class="empty-state" style="padding:16px;"><p>${MAN.carregando ? "Carregando..." : "Nenhuma semana nesta etapa."}</p></div>`;
  const hoje = frotaHojeISO();
  const dt = (x, etapa) => { const v = x.c[MAN_CAMPO[etapa]]; return v ? `<input type="date" class="nfe-pg bal-dt" value="${v}" onchange="manData('${x.ini}','${etapa}',this.value)">` : "—"; };
  return `<div style="overflow-x:auto; margin-top:10px;"><table class="nf-tab bal-tab">
    <thead><tr><th>Semana</th><th>Etapa</th><th>Doc. ao adm.</th><th>O.S Combitrans</th><th>Aprovação</th><th>NF</th><th>Pagamento</th><th>Próxima ação</th><th></th></tr></thead>
    <tbody>${lista.map(x=>{ const s = MAN_ETAPAS[x.st];
      const prazoTxt = x.st==="execucao" ? `termina ${nfeBR(x.fim)}` : x.prazo && !["recebida","sem_op"].includes(x.st)
        ? (x.atrasado ? `<b style="color:var(--red);">atrasado ${x.diasAtraso} dia(s)</b> · prazo era ${nfeBR(x.prazo)}` : `prazo ${nfeBR(x.prazo)}`) : "";
      const dataIn = `<input type="date" id="man-dt-${x.ini}" value="${hoje}" class="nfe-pg">`;
      const brl = (v) => v ? "R$ " + Number(v).toLocaleString("pt-BR", { minimumFractionDigits:2, maximumFractionDigits:2 }) : "";
      const osForm = `${dataIn} <input id="man-osn-${x.ini}" class="bal-num" placeholder="nº O.S" inputmode="numeric"> <input id="man-osv-${x.ini}" class="bal-num man-val" placeholder="R$ valor total" inputmode="numeric" oninput="osMascaraBRL(this)"> <button class="os-btn sm" onclick="manAvancar('${x.ini}','os')">🧾 Registrar O.S</button>`;
      const acao = x.st==="execucao" ? `<button class="os-link" onclick="manSemOp('${x.ini}', true)">marcar sem manutenção</button>`
        : x.st==="pend_doc" ? `${osForm}<div style="margin-top:4px; font-size:12px;"><button class="os-link" onclick="manAvancar('${x.ini}','documento')">só o documento foi ao adm. (O.S ainda não)</button> · <button class="os-link" onclick="manSemOp('${x.ini}', true)">sem manutenção</button></div>`
        : x.st==="pend_os" ? osForm
        : x.st==="assinatura" ? `${dataIn} <input id="man-osa-${x.ini}" class="bal-num man-val" placeholder="R$ valor aprovado" value="${brl(x.c.osValor)}" inputmode="numeric" oninput="osMascaraBRL(this)" title="Valor aprovado pela Combitrans"> <button class="os-btn sm" onclick="manAvancar('${x.ini}','assinatura')">✍️ O.S aprovada</button>`
        : x.st==="pend_nf" ? `<button class="os-btn sm green" onclick="manEmitirNF('${x.ini}')">🧾 Emitir NF</button>`
        : x.st==="nf_emitida" ? x.nfs.filter(r=>!r.dataPagamento).map(r=>nfePodeBaixar()
            ? `<span style="white-space:nowrap;">NF ${osEsc(r.nf)} <input type="date" id="man-pg-${r.id}" value="${hoje}" class="nfe-pg"> <button class="os-btn sm green" onclick="nfeBaixar('${r.id}','man-pg-${r.id}')">💵 Dar baixa</button></span>`
            : `<span class="bal-badge" style="--c:#8E2EB0;">aguardando baixa da Diretoria</span>`).join("<br>")
        : x.st==="sem_op" ? `<button class="os-link" onclick="manSemOp('${x.ini}', false)">desfazer</button>` : "✓";
      const nfTxt = x.nfs.length ? x.nfs.map(r=>`NF <b>${osEsc(r.nf)}</b> · ${fmtBRL2(r.valor)}<div class="hint" style="margin:0;">emitida ${fmtDataBR(r.dataEmissao)}</div>`).join("") : "—";
      const pgTxt = x.nfs.length ? x.nfs.map(r=>{ const v = nfeAddDias(r.dataEmissao, MAN_PRAZO_PGTO);
        return r.dataPagamento ? `<span class="badge green">✓ ${fmtDataBR(r.dataPagamento)}</span>` : `<span style="${hoje > v ? "color:var(--red); font-weight:800;" : ""}">vence ${fmtDataBR(v)}</span>`; }).join("<br>") : "—";
      return `<tr>
        <td><b>${nfeBR(x.ini)} a ${nfeBR(x.fim)}</b></td>
        <td><span class="bal-badge" style="--c:${s.cor};">${s.icone} ${s.label}</span>${prazoTxt ? `<div class="hint" style="margin:2px 0 0;">${prazoTxt}</div>` : ""}</td>
        <td>${dt(x,"documento")}</td>
        <td>${dt(x,"os")}${x.c.dataOS ? `<div class="man-os">nº <input class="bal-num" value="${osEsc(x.c.osNumero||"")}" placeholder="—" onchange="manOSCampo('${x.ini}','osNumero',this)">
          <input class="bal-num man-val" value="${brl(x.c.osValor)}" placeholder="R$ —" inputmode="numeric" oninput="osMascaraBRL(this)" onchange="manOSCampo('${x.ini}','osValor',this)"></div>` : ""}</td>
        <td>${dt(x,"assinatura")}${x.c.dataOS && !x.c.dataAssinatura ? `<div class="hint" style="margin:0;">limite ${nfeBR(nfeAddDias(x.c.dataOS, 7))}</div>` : ""}${x.c.dataAssinatura ? `<div class="man-os">aprovado <input class="bal-num man-val" value="${brl(x.c.osValorAprovado)}" placeholder="R$ —" inputmode="numeric" oninput="osMascaraBRL(this)" onchange="manOSCampo('${x.ini}','osValorAprovado',this)"></div>${x.c.osValor && x.c.osValorAprovado && Math.abs(x.c.osValor - x.c.osValorAprovado) > 0.005 ? `<div class="hint" style="margin:0; color:var(--red); font-weight:700;">diferença de ${brl(Math.abs(x.c.osValorAprovado - x.c.osValor))} ${x.c.osValorAprovado < x.c.osValor ? "a menos" : "a mais"}</div>` : ""}` : ""}</td>
        <td style="font-size:12.5px;">${nfTxt}</td><td style="font-size:12.5px;">${pgTxt}</td>
        <td style="white-space:nowrap;">${acao}</td>
        <td>${x.c.dataDocumento && !x.nfs.length ? `<button class="os-link" onclick="manVoltar('${x.ini}')" title="Voltar uma etapa">↩</button>` : ""}</td>
      </tr>`; }).join("")}</tbody>
  </table></div>`;
}

function manHTML(){
  manGarantirCarga();
  const cab = `<h3 style="margin:0;">🔧 Manutenção de Carreta — ciclo semanal (Combitrans)</h3>
    <div class="hint">Semana 1 execução → semana 2 documento ao administrativo e O.S para a Combitrans → Combitrans tem 7 dias para assinar → semana 4 NF da Avance → Combitrans paga em até 15 dias da emissão.</div>`;
  if(MAN.erro) return `<div class="panel" style="margin-bottom:16px;">${cab}<div class="os-alerta amber" style="margin-top:8px;">⚠️ Não foi possível carregar o ciclo da manutenção: ${osEsc(MAN.erro)}. Se falar em tabela inexistente ("manut_ciclos"), rode o SQL do ciclo da Manutenção de Carreta no Supabase.</div></div>`;
  const todos = manCiclos();
  const cont = {}; Object.keys(MAN_ETAPAS).forEach(k=>cont[k] = todos.filter(x=>x.st===k).length);
  const atr = {}; Object.keys(MAN_ETAPAS).forEach(k=>atr[k] = todos.filter(x=>x.st===k && x.atrasado).length);
  const lista = todos.filter(x=>MAN_FILTRO==="todas" || (MAN_FILTRO==="pendentes" ? !["recebida","sem_op"].includes(x.st) : x.st===MAN_FILTRO));
  const aReceber = sumArr(todos.filter(x=>x.st==="nf_emitida").flatMap(x=>x.nfs.filter(r=>!r.dataPagamento).map(r=>r.valor)));
  return `<div class="panel" style="margin-bottom:16px;">
    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;"><div>${cab}</div>
      <button class="sub-tab-btn ${MAN_FILTRO==="todas"?"active":""}" onclick="manFiltro('todas')">Ver todas (${todos.length})</button></div>
    <div class="bal-sts">${Object.entries(MAN_ETAPAS).filter(([k])=>k!=="sem_op" || cont[k]).map(([k,s])=>`<button class="bal-st ${MAN_FILTRO===k?"sel":""}" style="--c:${s.cor};" onclick="manFiltro('${k}')">
      <span class="lbl">${s.icone} ${s.label}</span><b>${cont[k]}</b>${atr[k] ? `<small style="color:var(--red); font-weight:800;">${atr[k]} atrasada(s)</small>` : k==="nf_emitida" && aReceber ? `<small>${fmtBRL(aReceber)} a receber</small>` : ""}</button>`).join("")}</div>
    <details class="nfe-sum" ${MAN_ABERTO ? "open" : ""} ontoggle="nfeAbrirLista('man', this.open)">
      <summary>Semanas — <b>${lista.length}</b> ${MAN_FILTRO==="todas" ? "no total" : MAN_FILTRO==="pendentes" ? "pendente(s)" : "em " + MAN_ETAPAS[MAN_FILTRO].label}<span class="nfe-sum-dica"></span></summary>
      ${manTabela(lista)}
    </details>
  </div>`;
}

/* -------------------- PAINEL GERENCIAL (aba da Emissão de NF · só Diretor) --------------------
   Uma linha por operação (as atividades das NF Emitidas) e uma coluna por etapa:
     Em operação → Pendente de documento → Pendente de NF → Aguardando recebimento → Recebido no mês.
   Logística Reversa: as etapas vêm do controle de balsas. Serviços com ritmo (semanal/quinzenal/mensal):
   "Pendente de NF" = períodos encerrados sem NF (vermelho quando o prazo já venceu).
   Recebimento: NFs sem baixa — a baixa do recebimento é feita pelo Diretor (aqui ou na lista das NF Emitidas). */
let NFG_SEL = null;   // { ativ, etapa } da célula clicada; null = lista de recebimentos para dar baixa
let NFG_MES = null;   // mês de emissão do bloco "Emitido por atividade" ("todos" = todos os meses)
window.nfgMes = (m) => { NFG_MES = m; if(NFG_SEL && NFG_SEL.etapa==="emitidas") NFG_SEL = null; nfeRerender(); };
function nfgDoMes(){ return NFE.lista.filter(r=>NFG_MES==="todos" || (r.dataEmissao||"").startsWith(NFG_MES)); }

// Emitido por atividade no mês de emissão escolhido: totais + um cartão por atividade (clique = lista das NFs)
function nfgEmitidoHTML(){
  const hojeMes = frotaHojeISO().slice(0,7);
  if(!NFG_MES) NFG_MES = hojeMes;
  const meses = [...new Set(NFE.lista.map(r=>(r.dataEmissao||"").slice(0,7)).filter(Boolean))].sort().reverse();
  if(!meses.includes(hojeMes)) meses.unshift(hojeMes);
  const nomeMes = (m) => m==="todos" ? "Todos os meses" : nfeNomeMes(m);
  const opt = (v,l) => `<option value="${v}" ${v===NFG_MES?"selected":""}>${osEsc(l)}</option>`;
  const doMes = nfgDoMes(), total = sumArr(doMes.map(r=>r.valor)), pagas = doMes.filter(r=>r.dataPagamento), vPago = sumArr(pagas.map(r=>r.valor)), vAberto = total - vPago;
  const sel = NFG_SEL && NFG_SEL.etapa==="emitidas" ? NFG_SEL.ativ : null;
  return `<div class="panel" style="margin-bottom:16px;">
    <div style="display:flex; justify-content:space-between; align-items:flex-end; gap:10px; flex-wrap:wrap;">
      <div><h3 style="margin:0;">🧾 Emitido por atividade — ${nomeMes(NFG_MES)}</h3>
        <div class="hint">Período pela data de emissão. Clique numa atividade para ver as NFs dela embaixo.</div></div>
      <div class="filtro-bar" style="margin:0;"><label>Mês de emissão<select onchange="nfgMes(this.value)">${opt("todos","Todos os meses")}${meses.map(m=>opt(m, nomeMes(m))).join("")}</select></label></div>
    </div>
    <div class="os-resumo prog-resumo nfe-tot" style="margin:10px 0;">
      <div>Emitido no período<b>${fmtBRL2(total)}</b><small>${doMes.length} NF(s)</small></div>
      <div>Pago<b style="color:var(--green);">${fmtBRL2(vPago)}</b><small>${pagas.length} NF(s) já pagas</small></div>
      <div>A receber<b style="color:var(--${vAberto>0.005?"amber":"green"});">${fmtBRL2(vAberto)}</b><small>${doMes.length-pagas.length} NF(s) em aberto</small></div>
      <div>% recebido<b>${total ? (vPago/total*100).toFixed(1).replace(".",",") : "0"}%</b><small>do valor emitido no período</small></div>
    </div>
    <div class="frota-ativs">${NFE_VISIVEIS().map(x=>{ const ls = doMes.filter(r=>r.atividade===x.chave), v = sumArr(ls.map(r=>r.valor));
      const sobe = ls.filter(r=>r.sentido==="sobe").length, desce = ls.filter(r=>r.sentido==="desce").length;
      return `<button class="frota-ativ ${sel===x.chave?"sel":""}" style="--c:${x.cor};" onclick="nfgSel('${x.chave}','emitidas')">
        <span class="frota-ativ-lbl">${x.label}</span><span class="frota-ativ-qtd" style="font-size:22px;">${fmtBRL(v)}</span>
        <span class="frota-ativ-sub">${ls.length} NF(s)${x.sentido && ls.length ? ` · ⬆️ ${sobe} · ⬇️ ${desce}` : ""}${total ? ` · ${(v/total*100).toFixed(0)}%` : ""}</span>${ls.length ? `<span class="frota-ativ-sub">💵 pago ${fmtBRL(sumArr(ls.filter(r=>r.dataPagamento).map(r=>r.valor)))}${ls.some(r=>!r.dataPagamento) ? ` · a receber ${fmtBRL(sumArr(ls.filter(r=>!r.dataPagamento).map(r=>r.valor)))}` : " ✓"}</span>` : ""}</button>`; }).join("")}</div>
    <div class="chart-wrap" style="height:${NFG_MES==="todos" ? 280 : 0}px; ${NFG_MES==="todos" ? "" : "display:none;"} margin-top:14px;"><canvas id="ch-nfg"></canvas></div>
  </div>`;
}
// Com "Todos os meses": colunas empilhadas por mês e atividade
function nfgGrafico(){
  const el = document.getElementById("ch-nfg"); if(!el || NFG_MES!=="todos") return;
  const meses = [...new Set(NFE.lista.map(r=>(r.dataEmissao||"").slice(0,7)).filter(Boolean))].sort();
  mkChart("ch-nfg", {
    type:"bar",
    data:{ labels:meses.map(nfeNomeMes), datasets:NFE_VISIVEIS().map(x=>({
      label:x.label, data:meses.map(m=>sumArr(NFE.lista.filter(r=>r.atividade===x.chave && (r.dataEmissao||"").startsWith(m)).map(r=>r.valor))),
      backgroundColor:x.cor, stack:"a", borderColor:"#fff", borderWidth:{ top:2 }, borderRadius:4, maxBarThickness:52 })) },
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ position:"bottom", labels:{ boxWidth:10, usePointStyle:true, pointStyle:"rectRounded" } }, datalabels:{ display:false },
        tooltip:{ mode:"index", filter:(it)=>it.raw>0, callbacks:{ label:(c)=>` ${c.dataset.label}: ${fmtBRL(c.raw)}` } } },
      scales:{ x:{ stacked:true, grid:{ display:false } }, y:{ stacked:true, grid:{ color:COLORS.grid }, ticks:{ callback:v=>fmtMil(v) } } } }
  });
}
const NFG_ETAPAS = [
  { k:"operacao", label:"Em operação",            cor:"#2E6DB0" },
  { k:"doc",      label:"Pendente de documento",  cor:"#E1971F" },
  { k:"nf",       label:"Pendente de NF",         cor:"#D0021B" },
  { k:"receber",  label:"Aguardando recebimento", cor:"#8E2EB0" },
  { k:"recebido", label:"Recebido no mês",        cor:"#1C9A6C" },
];
window.nfgSel = (ativ, etapa) => {
  // NFs pendentes (aguardando recebimento) abrem a lista de recebimentos já filtrada, com PDF e WhatsApp
  if(etapa==="receber" || etapa==="todas_pendentes"){
    NFG_SEL = null; NFG_COB_ATIV = etapa==="todas_pendentes" || NFG_COB_ATIV===ativ ? "todas" : ativ;   // clicar de novo volta para todas
    nfeRerender(); document.getElementById("nfg-det")?.scrollIntoView({ behavior:"smooth", block:"start" }); return;
  }
  NFG_SEL = ativ===null || (NFG_SEL && NFG_SEL.ativ===ativ && NFG_SEL.etapa===etapa) ? null : { ativ, etapa };
  nfeRerender(); document.getElementById("nfg-det")?.scrollIntoView({ behavior:"smooth", block:"start" });
};
window.nfgIrBalsas = () => { BAL_FILTRO = "pendentes"; setNfAba("nfe"); };

// Campo de baixa do recebimento (só o Diretor dá baixa; os outros perfis veem "aguardando")
function nfeBaixaHTML(r){
  const dias = nfeDias(r.dataEmissao, frotaHojeISO()), venc = r.atividade==="manutencao" ? nfeAddDias(r.dataEmissao, MAN_PRAZO_PGTO) : null;
  const idade = `<span class="hint" style="margin:0 6px 0 0;">em aberto há <b style="color:var(--${nfeVencida(r)?"red":"ink"});">${dias}</b> dias${venc ? ` · vence ${nfeBR(venc)}` : ""}</span>`;
  return nfePodeBaixar()
    ? `${idade}<input type="date" id="nfe-pg-${r.id}" value="${frotaHojeISO()}" class="nfe-pg"> <button class="os-btn sm green" onclick="nfeBaixar('${r.id}')">💵 Dar baixa</button>`
    : `${idade}<span class="bal-badge" style="--c:#8E2EB0;">aguardando baixa da Diretoria</span>`;
}

// NF em aberto além do prazo: Manutenção (Combitrans) 15 dias da emissão; demais 30 dias
function nfeVencida(r){ return !r.dataPagamento && nfeDias(r.dataEmissao, frotaHojeISO()) > (r.atividade==="manutencao" ? MAN_PRAZO_PGTO : 30); }
function nfgLinha(a){
  const hoje = frotaHojeISO(), mes = hoje.slice(0,7);
  const nfs = NFE.lista.filter(r=>r.atividade===a.chave);
  const receber = nfs.filter(r=>!r.dataPagamento), recebido = nfs.filter(r=>r.dataPagamento && r.dataPagamento.startsWith(mes));
  const it = {
    receber:  { qtd:receber.length, valor:sumArr(receber.map(r=>r.valor)), nfs:receber, alerta:receber.some(nfeVencida) },
    recebido: { qtd:recebido.length, valor:sumArr(recebido.map(r=>r.valor)), nfs:recebido },
  };
  if(a.chave==="manutencao"){   // ciclo semanal da Combitrans
    const cs = manCiclos(), g = (...sts) => cs.filter(x=>sts.includes(x.st)), atual = g("execucao")[0];
    const d = g("pend_doc","pend_os","assinatura"), n = g("pend_nf");
    it.operacao = { texto: atual ? `Semana ${nfeBR(atual.ini)} a ${nfeBR(atual.fim)}` : "—", ciclos: atual ? [atual] : [] };
    const vOS = (l) => sumArr(l.map(x=>x.c.osValorAprovado || x.c.osValor || 0));   // valor da O.S (aprovado, senão o total)
    it.doc = { qtd:d.length, ciclos:d, alerta:d.some(x=>x.atrasado), valorOS:vOS(d) };
    it.nf = { qtd:n.length, ciclos:n, alerta:n.some(x=>x.atrasado), valorOS:vOS(n) };
  } else if(nfeEhLR(a.chave)){
    const bs = BAL.lista.filter(b=>b.atividade===a.chave);
    const g = (st) => bs.filter(b=>balStatus(b)===st);
    const velha = (l) => l.some(b=>(balDesdeEtapa(b)||0) > 7);
    it.operacao = { qtd:g("aberta").length, balsas:g("aberta") };
    it.doc = { qtd:g("pend_doc").length, balsas:g("pend_doc"), alerta:velha(g("pend_doc")) };
    it.nf  = { qtd:g("pend_nf").length, balsas:g("pend_nf"), alerta:g("pend_nf").length > 0 };
  } else if(a.cad){
    const per = nfePeriodos(a.cad).map(p=>({ p, st:nfeStatus(a.chave, p) }));
    const atual = per.find(x=>x.p.ini <= hoje && x.p.fim >= hoje);
    const pend = per.filter(x=>x.st.cor==="vermelho" || x.st.cor==="amarelo" || (x.st.cor==="cinza" && x.p.fim < hoje));
    it.operacao = { texto: atual ? atual.p.rotulo : "—", periodos: atual ? [atual] : [] };
    it.nf = { qtd:pend.length, periodos:pend, alerta:pend.some(x=>x.st.cor==="vermelho") };
  }
  return { a, it };
}

function nfgPagina(){
  if(!NFE.carregado && !NFE.carregando){ NFE.carregando = true; setTimeout(()=>nfeCarregar(), 0); }
  if(!BAL.carregado && !BAL.carregando){ BAL.carregando = true; setTimeout(()=>balCarregar(), 0); }
  manGarantirCarga();
  if(NFE.erro) return `<div class="panel"><div class="empty-state" style="padding:24px;"><div class="glyph">⚠️</div><h4>Não foi possível carregar as NF emitidas</h4><p>${osEsc(NFE.erro)}</p></div></div>`;
  if(!NFE.carregado) return `<div class="panel"><div class="empty-state" style="padding:24px;"><p>Carregando...</p></div></div>`;
  const hoje = frotaHojeISO(), mes = hoje.slice(0,7);
  const ativs = NFE_ATIVIDADES.filter(a=>!a.oculto || NFE.lista.some(r=>r.atividade===a.chave && !r.dataPagamento));
  const linhas = ativs.map(nfgLinha);
  const pend = NFE.lista.filter(r=>!r.dataPagamento), pagasMes = NFE.lista.filter(r=>r.dataPagamento && r.dataPagamento.startsWith(mes));
  const vencidas = pend.filter(nfeVencida);
  const lt = NFE.lista.filter(r=>r.dataPagamento && nfeDias(r.dataPagamento, hoje) <= 90).map(r=>nfeDias(r.dataEmissao, r.dataPagamento));
  const nPendNF = sumArr(linhas.map(L=>L.it.nf ? L.it.nf.qtd : 0)), nPendDoc = sumArr(linhas.map(L=>L.it.doc ? L.it.doc.qtd : 0));
  const nAtrasadas = sumArr(linhas.map(L=>L.it.nf ? (L.it.nf.periodos ? L.it.nf.periodos.filter(x=>x.st.cor==="vermelho").length : L.it.nf.ciclos ? L.it.nf.ciclos.filter(x=>x.atrasado).length : L.it.nf.qtd) : 0));
  const faixas = [["Até 15 dias",0,15],["16 a 30 dias",16,30],["31 a 60 dias",31,60],["Mais de 60 dias",61,99999]].map(([l,de,ate])=>{
    const ls = pend.filter(r=>{ const d = nfeDias(r.dataEmissao, hoje); return d>=de && d<=ate; }); return { l, qtd:ls.length, valor:sumArr(ls.map(r=>r.valor)), cor: de>60 ? "#8C0011" : de>30 ? "#D0021B" : de>15 ? "#E1971F" : "#1C9A6C" }; });
  const totPend = sumArr(pend.map(r=>r.valor));

  const cel = (L, e) => {
    const x = L.it[e.k]; if(!x) return `<td class="nfg-na" title="Não se aplica a esta operação">—</td>`;
    const sel = e.k==="receber" ? !NFG_SEL && NFG_COB_ATIV===L.a.chave : NFG_SEL && NFG_SEL.ativ===L.a.chave && NFG_SEL.etapa===e.k;
    const clique = `onclick="nfgSel('${L.a.chave}','${e.k}')"`;
    if(x.texto!=null) return `<td><button class="nfg-cel ${sel?"sel":""}" style="--c:${e.cor};" ${clique}><span class="nfg-run">▶ em execução</span><small>${osEsc(x.texto)}</small></button></td>`;
    return `<td><button class="nfg-cel ${x.qtd?"":"zero"} ${x.alerta?"alerta":""} ${sel?"sel":""}" style="--c:${e.cor};" ${clique}>
      <b>${x.qtd}</b>${x.valor!=null && x.qtd ? `<small>${fmtBRL(x.valor)}</small>` : x.qtd && x.balsas ? `<small>balsa(s)</small>` : x.qtd && x.periodos ? `<small>período(s)</small>` : x.qtd && x.ciclos ? `<small>semana(s)</small>${x.valorOS ? `<small>${fmtBRL(x.valorOS)}</small>` : ""}` : ""}</button></td>`;
  };
  const tot = (k) => { const ls = linhas.map(L=>L.it[k]).filter(Boolean); const q = sumArr(ls.map(x=>x.qtd||0)), v = sumArr(ls.map(x=>(x.valor||0) + (x.valorOS||0)));
    return k==="operacao" ? `<td>${sumArr(ls.map(x=>x.qtd||0)) || ""}</td>` : `<td><b>${q}</b>${v ? `<div class="hint" style="margin:0;">${fmtBRL(v)}</div>` : ""}</td>`; };

  return `
    <div class="os-resumo prog-resumo nfe-tot" style="margin:0 0 14px;">
      <div class="nfg-kpi-link" onclick="nfgSel(null,'todas_pendentes')" title="Ver as NFs pendentes">A receber<b style="color:var(--amber);">${fmtBRL(totPend)}</b><small>${pend.length} NF(s) aguardando baixa · <u>ver</u></small></div>
      <div>Vencido<b style="color:var(--${vencidas.length?"red":"green"});">${fmtBRL(sumArr(vencidas.map(r=>r.valor)))}</b><small>${vencidas.length} NF(s) além do prazo · Manutenção 15 dias, demais 30</small></div>
      <div>Recebido no mês<b style="color:var(--green);">${fmtBRL(sumArr(pagasMes.map(r=>r.valor)))}</b><small>${pagasMes.length} NF(s) · ${nfeNomeMes(mes)}</small></div>
      <div>Pendências de emissão<b style="color:var(--${nAtrasadas?"red":nPendNF+nPendDoc?"amber":"green"});">${nPendNF + nPendDoc}</b><small>${nPendDoc} aguardando documento · ${nPendNF} aguardando NF${nAtrasadas ? ` · <span style="color:var(--red); font-weight:800;">${nAtrasadas} atrasada(s)</span>` : ""}</small></div>
      <div>Lead time médio<b>${lt.length ? Math.round(sumArr(lt)/lt.length) + " dias" : "—"}</b><small>emissão → recebimento · últimos 90 dias</small></div>
    </div>

    <div class="panel" style="margin-bottom:16px;">
      <h3 style="margin:0;">📋 Status por operação</h3>
      <div class="hint">Cada linha é uma operação; cada coluna, uma etapa até o dinheiro entrar. Clique num número para ver o detalhe embaixo. Destaque = precisa de atenção (NF atrasada, documento parado há mais de 7 dias ou NF em aberto há mais de 30 dias).</div>
      <div style="overflow-x:auto; margin-top:10px;"><table class="nf-tab nfg-tab">
        <thead><tr><th>Operação</th>${NFG_ETAPAS.map(e=>`<th><span class="nfe-dot" style="--c:${e.cor};"></span>${e.label}</th>`).join("")}</tr></thead>
        <tbody>${linhas.map(L=>`<tr><td><span class="nfe-dot" style="--c:${L.a.cor};"></span><b>${L.a.label}</b><div class="hint" style="margin:0;">${nfeEhLR(L.a.chave) ? "por balsa" : L.a.cad ? ({semanal:"semanal",quinzenal:"quinzenal",mensal:"mensal"})[L.a.cad] : "avulsa"}</div></td>${NFG_ETAPAS.map(e=>cel(L, e)).join("")}</tr>`).join("")}</tbody>
        <tfoot><tr style="font-weight:800; background:var(--paper);"><td>Total</td>${NFG_ETAPAS.map(e=>tot(e.k)).join("")}</tr></tfoot>
      </table></div>
    </div>

    ${nfgEmitidoHTML()}

    ${manHTML()}

    <div class="panel" style="margin-bottom:16px;">
      <h3 style="margin:0;">⏳ Idade do contas a receber</h3>
      <div class="hint">NFs sem baixa, pela quantidade de dias desde a emissão.</div>
      <div class="bal-sts">${faixas.map(f=>`<div class="bal-st" style="--c:${f.cor}; cursor:default;"><span class="lbl">${f.l}</span><b>${fmtBRL(f.valor)}</b><small>${f.qtd} NF(s)${totPend ? ` · ${(f.valor/totPend*100).toFixed(0)}%` : ""}</small></div>`).join("")}</div>
    </div>

    <div class="panel" id="nfg-det">${nfgDetalhe(linhas)}</div>`;
}

/* ---------- Cobrança: PDF das NFs em aberto (para o Diretor enviar ao cliente) ----------
   Gera o PDF no navegador (jsPDF, arquivos locais carregados só quando precisa). "Enviar no WhatsApp"
   usa o compartilhamento do aparelho/Windows (escolhe o WhatsApp e o PDF vai anexado); onde o
   navegador não permite anexar, baixa o PDF e abre o WhatsApp com o resumo para anexar o arquivo. */
let NFG_COB_ATIV = "todas";
window.nfgCobAtiv = (v) => { NFG_COB_ATIV = v; nfeRerender(); };
function nfgCobLista(){ return NFE.lista.filter(r=>!r.dataPagamento && (NFG_COB_ATIV==="todas" || r.atividade===NFG_COB_ATIV)).sort((a,b)=>(a.dataEmissao||"").localeCompare(b.dataEmissao||"") || (a.nf||"").localeCompare(b.nf||"")); }
let NFG_PDF_LIB = null;
function nfgCarregarPDF(){
  if(window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API.autoTable) return Promise.resolve();
  if(NFG_PDF_LIB) return NFG_PDF_LIB;
  const carregar = (src) => new Promise((ok, erro)=>{ const el = document.createElement("script"); el.src = src; el.onload = ok; el.onerror = () => erro(new Error("não carregou " + src)); document.head.appendChild(el); });
  NFG_PDF_LIB = carregar("jspdf.umd.min.js").then(()=>carregar("jspdf.plugin.autotable.min.js")).catch(e=>{ NFG_PDF_LIB = null; throw e; });
  return NFG_PDF_LIB;
}
const nfgBRL = (v) => "R$ " + Number(v||0).toLocaleString("pt-BR", { minimumFractionDigits:2, maximumFractionDigits:2 });
function nfgCobNomeArquivo(){ const h = frotaHojeISO(); return `Avance_NFs_em_aberto_${NFG_COB_ATIV==="todas" ? "" : nfSemAcento(nfeAtiv(NFG_COB_ATIV).label).replace(/[^A-Z0-9]+/g,"_") + "_"}${h.slice(8,10)}-${h.slice(5,7)}-${h.slice(0,4)}.pdf`; }
function nfgCobTexto(ls){
  const hoje = frotaHojeISO(), total = sumArr(ls.map(r=>r.valor)), velha = ls[0];
  return `*Avance Transporte Logístico*\nRelação de NFs em aberto — posição em ${fmtDataBR(hoje)}\n`
    + `Operação: ${NFG_COB_ATIV==="todas" ? "todas" : nfeAtiv(NFG_COB_ATIV).label}\n`
    + `Total em aberto: *${nfgBRL(total)}* (${ls.length} NF${ls.length===1?"":"s"})\n`
    + (velha ? `NF mais antiga: ${velha.nf} de ${fmtDataBR(velha.dataEmissao)} (${nfeDias(velha.dataEmissao, hoje)} dias)\n` : "")
    + `Segue o PDF com o detalhamento.`;
}
async function nfgCobPDF(ls){
  await nfgCarregarPDF();
  const { jsPDF } = window.jspdf, doc = new jsPDF({ unit:"mm", format:"a4" });
  const hoje = frotaHojeISO(), W = doc.internal.pageSize.getWidth(), total = sumArr(ls.map(r=>r.valor));
  const operacao = NFG_COB_ATIV==="todas" ? "Todas as operações" : nfeAtiv(NFG_COB_ATIV).label;
  doc.setFillColor(208, 2, 27); doc.rect(0, 0, W, 4, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.setTextColor(20, 20, 26); doc.text("AVANCE TRANSPORTE LOGÍSTICO", 14, 16);
  doc.setFontSize(12); doc.setTextColor(208, 2, 27); doc.text("Relação de notas fiscais em aberto", 14, 23);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(90, 90, 100);
  doc.text(`Posição em ${fmtDataBR(hoje)}  ·  Operação: ${operacao}`, 14, 29);
  // resumo
  const velha = ls[0], caixas = [["Total em aberto", nfgBRL(total)], ["Notas fiscais", String(ls.length)], ["NF mais antiga", velha ? `${nfeDias(velha.dataEmissao, hoje)} dias` : "-"]];
  const bw = (W - 28 - 8) / 3;
  caixas.forEach(([l, v], i)=>{ const x = 14 + i*(bw+4); doc.setFillColor(245, 245, 247); doc.roundedRect(x, 34, bw, 17, 2, 2, "F");
    doc.setFontSize(8); doc.setTextColor(110, 110, 120); doc.text(l.toUpperCase(), x+4, 40);
    doc.setFont("helvetica", "bold"); doc.setFontSize(12.5); doc.setTextColor(20, 20, 26); doc.text(v, x+4, 47.5); doc.setFont("helvetica", "normal"); });
  let y = 58;
  // por operação (só quando são várias)
  const ops = NFE_ATIVIDADES.map(a=>({ a, l:ls.filter(r=>r.atividade===a.chave) })).filter(o=>o.l.length);
  if(ops.length > 1){
    doc.autoTable({ startY:y, head:[["Operação", "NFs", "Valor em aberto"]], body:ops.map(o=>[o.a.label, String(o.l.length), nfgBRL(sumArr(o.l.map(r=>r.valor)))]),
      foot:[["Total", String(ls.length), nfgBRL(total)]], theme:"grid", margin:{ left:14, right:14 },
      styles:{ fontSize:9, cellPadding:2 }, headStyles:{ fillColor:[20,20,26] }, footStyles:{ fillColor:[245,245,247], textColor:[20,20,26], fontStyle:"bold" },
      columnStyles:{ 1:{ halign:"center", cellWidth:20 }, 2:{ halign:"right", cellWidth:45 } },
      didParseCell:(d)=>{ if(d.column.index===2) d.cell.styles.halign = "right"; if(d.column.index===1) d.cell.styles.halign = "center"; } });
    y = doc.lastAutoTable.finalY + 8;
  }
  doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.setTextColor(20, 20, 26); doc.text("Detalhamento das notas fiscais", 14, y); y += 3;
  doc.autoTable({ startY:y,
    head:[["NF", "Emissão", "Operação", "Balsa / Período", "Dias em aberto", "Valor"]],
    body:ls.map(r=>{ const b = nfeBalsaDe(r), per = nfePeriodoNF(r);
      return [r.nf, fmtDataBR(r.dataEmissao), nfeRotulo(r), [b ? `${b}${r.numero ? " - " + r.numero : ""}` : "", per!=="—" ? per : ""].filter(Boolean).join("  ·  ") || "-", String(nfeDias(r.dataEmissao, hoje)), nfgBRL(r.valor)]; }),
    foot:[[{ content:`Total (${ls.length} NF${ls.length===1?"":"s"})`, colSpan:5 }, nfgBRL(total)]],
    theme:"striped", margin:{ left:14, right:14 }, styles:{ fontSize:8.5, cellPadding:1.8, valign:"middle" },
    headStyles:{ fillColor:[208,2,27] }, footStyles:{ fillColor:[20,20,26], textColor:[255,255,255], fontStyle:"bold" },
    columnStyles:{ 0:{ fontStyle:"bold", cellWidth:16 }, 1:{ cellWidth:20 }, 4:{ halign:"center", cellWidth:20 }, 5:{ halign:"right", cellWidth:28 } },
    showFoot:"lastPage", didParseCell:(d)=>{ if(d.column.index===5) d.cell.styles.halign = "right"; if(d.column.index===4 && d.section==="head") d.cell.styles.halign = "center"; } });
  const n = doc.internal.getNumberOfPages();
  for(let i = 1; i <= n; i++){ doc.setPage(i); doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(140, 140, 150);
    doc.text(`Avance Transporte Logístico · gerado em ${fmtDataBR(hoje)} às ${frotaHora()}`, 14, 290); doc.text(`Página ${i} de ${n}`, W-14, 290, { align:"right" }); }
  return doc;
}
window.nfgCobBaixar = async () => {
  const ls = nfgCobLista(); if(!ls.length){ toast("Nenhuma NF em aberto nesse filtro."); return; }
  try{ (await nfgCobPDF(ls)).save(nfgCobNomeArquivo()); toast("PDF gerado ✓"); }catch(e){ toast("⚠ Não foi possível gerar o PDF: " + e.message); }
};
window.nfgCobWhatsApp = async () => {
  const ls = nfgCobLista(); if(!ls.length){ toast("Nenhuma NF em aberto nesse filtro."); return; }
  let doc; try{ doc = await nfgCobPDF(ls); }catch(e){ toast("⚠ Não foi possível gerar o PDF: " + e.message); return; }
  const nome = nfgCobNomeArquivo(), texto = nfgCobTexto(ls);
  const arq = new File([doc.output("blob")], nome, { type:"application/pdf" });
  if(navigator.canShare && navigator.canShare({ files:[arq] })){
    try{ await navigator.share({ files:[arq], title:"NFs em aberto — Avance", text:texto.replace(/\*/g,"") }); return; }
    catch(e){ if(e.name === "AbortError") return; }   // cancelou o compartilhamento
  }
  doc.save(nome);
  window.open("https://wa.me/?text=" + encodeURIComponent(texto), "_blank");
  toast("PDF baixado — no WhatsApp, anexe o arquivo " + nome);
};

function nfgDetalhe(linhas){
  const hoje = frotaHojeISO();
  const L = NFG_SEL ? linhas.find(x=>x.a.chave===NFG_SEL.ativ) : null;
  const e = NFG_SEL ? NFG_ETAPAS.find(x=>x.k===NFG_SEL.etapa) : null;
  const x = L && e ? L.it[e.k] : null;
  const voltar = `<button class="os-btn sm" onclick="nfgSel(null)">← Ver recebimentos para dar baixa</button>`;
  const tabNF = (ls, pagas) => ls.length ? `<div style="overflow-x:auto;"><table class="nf-tab">
      <thead><tr><th>Operação</th><th>Período / Balsa</th><th>NF</th><th class="num">Valor</th><th>Emissão</th><th>${pagas ? "Recebimento" : "Baixa do recebimento"}</th></tr></thead>
      <tbody>${ls.map(r=>`<tr><td><span class="nfe-dot" style="--c:${nfeAtiv(r.atividade).cor};"></span>${osEsc(nfeRotulo(r))}</td>
        <td style="font-size:12px;">${nfeBalsaDe(r) ? `🚢 ${osEsc(nfeBalsaDe(r))}${r.numero ? " – " + osEsc(r.numero) : ""}<br>` : ""}${osEsc(nfePeriodoNF(r))}</td>
        <td><b>${osEsc(r.nf)}</b></td><td class="num"><b>${fmtBRL2(r.valor)}</b></td><td>${fmtDataBR(r.dataEmissao)}</td>
        <td style="white-space:nowrap;">${r.dataPagamento ? `<span class="badge green">✓ recebido ${fmtDataBR(r.dataPagamento)}</span> <span class="hint" style="margin:0;">${nfeDias(r.dataEmissao, r.dataPagamento)} dias</span>${nfePodeBaixar() ? ` <button class="os-link" onclick="nfeEstornar('${r.id}')">desfazer</button>` : ""}` : nfeBaixaHTML(r)}</td></tr>`).join("")}</tbody>
      <tfoot><tr style="font-weight:800; background:var(--paper);"><td colspan="3">Total (${ls.length})</td><td class="num">${fmtBRL2(sumArr(ls.map(r=>r.valor)))}</td><td colspan="2"></td></tr></tfoot>
    </table></div>` : `<div class="empty-state" style="padding:16px;"><p>Nada nesta etapa.</p></div>`;

  if(NFG_SEL && NFG_SEL.etapa==="emitidas"){
    const a = nfeAtiv(NFG_SEL.ativ), ls = nfgDoMes().filter(r=>r.atividade===a.chave).sort((p,q)=>(p.dataEmissao||"").localeCompare(q.dataEmissao||""));
    return `<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;"><h3 style="margin:0;"><span class="nfe-dot" style="--c:${a.cor};"></span>${a.label} — NFs emitidas · ${NFG_MES==="todos" ? "todos os meses" : nfeNomeMes(NFG_MES)}</h3>${voltar}</div>` + tabNF(ls, false);
  }
  if(!x){
    nfgCarregarPDF().catch(()=>{});   // deixa a biblioteca do PDF pronta para o clique
    const pend = nfgCobLista(), ativs = NFE_ATIVIDADES.filter(a=>NFE.lista.some(r=>!r.dataPagamento && r.atividade===a.chave));
    return `<div style="display:flex; justify-content:space-between; align-items:flex-end; gap:10px; flex-wrap:wrap;">
        <div><h3 style="margin:0;">💵 Recebimentos aguardando baixa (${pend.length})</h3>
          <div class="hint">Da NF mais antiga para a mais nova. Quando o valor cair na conta, escolha a data e clique em "Dar baixa".</div></div>
        <div class="nfg-cob">
          <label>Operação<select onchange="nfgCobAtiv(this.value)"><option value="todas">Todas as operações</option>${ativs.map(a=>`<option value="${a.chave}" ${NFG_COB_ATIV===a.chave?"selected":""}>${a.label}</option>`).join("")}</select></label>
          <button class="os-btn" onclick="nfgCobBaixar()">📄 Baixar PDF</button>
          <button class="os-btn green" onclick="nfgCobWhatsApp()">📲 Enviar no WhatsApp</button>
        </div>
      </div>${tabNF(pend, false)}`;
  }
  const tit = `<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;"><h3 style="margin:0;"><span class="nfe-dot" style="--c:${e.cor};"></span>${L.a.label} — ${e.label}</h3>${voltar}</div>`;
  if(x.ciclos) return tit + manTabela(x.ciclos);
  if(x.nfs) return tit + tabNF([...x.nfs].sort((a,b)=>(a.dataEmissao||"").localeCompare(b.dataEmissao||"")), e.k==="recebido");
  if(x.balsas) return tit + (x.balsas.length ? `<div style="overflow-x:auto; margin-top:8px;"><table class="nf-tab">
      <thead><tr><th>Balsa</th><th>Nº</th><th>Abertura</th><th>Fechamento</th><th>Documento</th><th>Status</th></tr></thead>
      <tbody>${x.balsas.map(b=>{ const s = BAL_STATUS[balStatus(b)], d = balDesdeEtapa(b); return `<tr><td><b>${osEsc(b.balsa)}</b></td><td>${osEsc(b.numero)||"—"}</td>
        <td>${b.dataAbertura ? fmtDataBR(b.dataAbertura) : "—"}</td><td>${b.dataFechamento ? fmtDataBR(b.dataFechamento) : "—"}</td><td>${b.dataDocumento ? fmtDataBR(b.dataDocumento) : "—"}</td>
        <td><span class="bal-badge" style="--c:${s.cor};">${s.icone} ${s.label}</span>${d!=null ? `<div class="hint" style="margin:2px 0 0; ${d>7?"color:var(--red); font-weight:700;":""}">há ${d} dia(s) nesta etapa</div>` : ""}</td></tr>`; }).join("")}</tbody>
    </table></div><div style="margin-top:10px;"><button class="os-btn sm" onclick="nfgIrBalsas()">🚢 Abrir o controle de balsas</button></div>` : `<div class="empty-state" style="padding:16px;"><p>Nenhuma balsa nesta etapa.</p></div>`);
  if(x.periodos){
    const corTxt = { vermelho:"var(--red)", amarelo:"#8a5a0c", verde:"var(--green)", cinza:"var(--ink-soft)" };
    return tit + (x.periodos.length ? `<div style="overflow-x:auto; margin-top:8px;"><table class="nf-tab">
      <thead><tr><th>Período</th><th>Prazo da NF</th><th>Situação</th><th>NF(s)</th><th>Observação</th></tr></thead>
      <tbody>${x.periodos.map(({p, st})=>`<tr><td><b>${osEsc(p.rotulo)}</b></td><td>${fmtDataBR(p.prazo)}</td>
        <td style="font-weight:800; color:${corTxt[st.cor]};">${osEsc(st.texto)}</td>
        <td>${st.nfs.length ? st.nfs.map(r=>`NF ${osEsc(r.nf)} · ${fmtBRL2(r.valor)}`).join("<br>") : "—"}</td><td>${osEsc(st.man.obs||"")||"—"}</td></tr>`).join("")}</tbody>
    </table></div>` : `<div class="empty-state" style="padding:16px;"><p>Nenhum período pendente de NF. ✓</p></div>`);
  }
  return tit;
}

/* ---------- Calendário de lead time das operações (topo do Painel Gerencial) ----------
   Referência de prazos por operação: execução → emissão do documento → emissão da NF (1 dia).
   Todas as barras na MESMA escala de dias, para comparar o lead time das operações; abaixo de cada barra,
   as datas do ciclo que está correndo agora e a marca de "hoje". */
const NFG_LEADTIME = [
  { chave:"lr_sw",           label:"Logística Reversa",            exec:"semanal", doc:"semanal", nf:1 },
  { chave:"desatrelamento",  label:"Desatrelamento SW",            exec:"semanal", doc:"semanal", nf:1 },
  { chave:"puxadas",         label:"Puxada de carreta avaria NC",  exec:"semanal", doc:"semanal", nf:1 },
  { chave:"devolucao_motos", label:"Devolução de motos",           exec:"mensal",  doc:"mensal",  nf:1 },
  { chave:"manutencao",      label:"Manutenção de Carreta",        exec:"semanal", doc:"semanal", nf:1 },
  { chave:"lr_carreteira",   label:"Logística Reversa Carreteira", exec:"semanal", doc:"semanal", nf:1 },
];
const NFG_LT_FASES = [
  { k:"exec", label:"Execução",              cor:"#2E6DB0" },
  { k:"doc",  label:"Emissão de documento",  cor:"#E1971F" },
  { k:"nf",   label:"Emissão da NF",         cor:"#1C9A6C" },
];
// Abre como janela por cima da tela (botão no topo do Painel Gerencial); fecha no ✕, clicando fora ou com Esc
window.nfgLtAbrir = () => {
  nfgLtFechar();
  const d = document.createElement("div"); d.className = "nfg-lt-modal"; d.id = "nfg-lt-modal";
  d.onclick = (e) => { if(e.target === d) nfgLtFechar(); };
  d.innerHTML = nfgLeadTimeHTML(); document.body.appendChild(d); document.body.style.overflow = "hidden";
};
window.nfgLtFechar = () => { const d = document.getElementById("nfg-lt-modal"); if(d){ d.remove(); document.body.style.overflow = ""; } };
document.addEventListener("keydown", (e)=>{ if(e.key === "Escape") nfgLtFechar(); });
// Ciclo que contém hoje: semanal = segunda a domingo; mensal = mês corrente
function nfgLtCiclo(o){
  const hoje = frotaHojeISO();
  const bloco = (cad, ini) => cad==="mensal" ? { ini, fim:nfeFimMes(ini.slice(0,7)) } : { ini, fim:nfeAddDias(ini, 6) };
  const ini = o.exec==="mensal" ? `${hoje.slice(0,7)}-01` : nfeSegunda(hoje);
  const exec = bloco(o.exec, ini);
  const doc = bloco(o.doc, nfeAddDias(exec.fim, 1));
  const nf = { ini:nfeAddDias(doc.fim, 1), fim:nfeAddDias(doc.fim, o.nf) };
  const dur = (b) => nfeDias(b.ini, b.fim) + 1;
  return { ini, exec, doc, nf, d:{ exec:dur(exec), doc:dur(doc), nf:dur(nf) }, total:dur(exec)+dur(doc)+dur(nf), hojeDia:nfeDias(ini, hoje) };
}
function nfgLeadTimeHTML(){
  const linhas = NFG_LEADTIME.map(o=>({ o, a:nfeAtiv(o.chave), c:nfgLtCiclo(o) }));
  const escala = Math.ceil(Math.max(...linhas.map(l=>l.c.total)) / 7) * 7;   // semanas inteiras
  const pct = (dias) => (dias / escala * 100).toFixed(3) + "%";
  const cad = (v) => v==="mensal" ? "Mensal" : "Semanal";
  const per = (b) => b.ini===b.fim ? nfeBR(b.ini) : `${nfeBR(b.ini)} a ${nfeBR(b.fim)}`;
  const ticks = []; for(let d = 0; d <= escala; d += 7) ticks.push(d);
  const semanais = linhas.filter(l=>l.o.exec==="semanal"), mensal = linhas.find(l=>l.o.exec==="mensal");
  return `<div class="panel nfg-lt" role="dialog" aria-label="Calendário de lead time das operações">
    <div class="nfg-lt-topo">
      <div><h3>🗓️ Calendário de lead time das operações</h3>
        <div class="hint" style="margin:2px 0 0;">Da execução do serviço até a emissão da NF — todas as operações na mesma escala de dias</div></div>
      <div class="nfg-lt-resumo">
        ${semanais.length ? `<span><b>${semanais[0].c.total} dias</b> operações semanais</span>` : ""}
        ${mensal ? `<span><b>${mensal.c.total} dias</b> ${mensal.o.label.toLowerCase()}</span>` : ""}
        <button class="nfg-lt-fechar" onclick="nfgLtFechar()" title="Fechar (Esc)">✕</button>
      </div>
    </div>
    <div class="nfg-lt-legenda">${NFG_LT_FASES.map(f=>`<span><i style="background:${f.cor};"></i>${f.label}</span>`).join("")}<span><i class="hoje"></i>Hoje</span></div>
    <div class="nfg-lt-grid">
      <div class="nfg-lt-cab"></div>
      <div class="nfg-lt-regua">${ticks.map(d=>`<span style="left:${pct(d)};">${d===0 ? "início" : d + "d"}</span>`).join("")}</div>
      ${linhas.map(({o, a, c})=>`
        <div class="nfg-lt-nome"><span class="nfe-dot" style="--c:${a.cor};"></span><div><b>${o.label}</b>
          <div class="nfg-lt-cad">${cad(o.exec)} · ${cad(o.doc)} · NF ${o.nf} dia</div></div></div>
        <div class="nfg-lt-linha">
          <div class="nfg-lt-trilho">
            ${ticks.slice(1, -1).map(d=>`<i class="nfg-lt-grade" style="left:${pct(d)};"></i>`).join("")}
            <div class="nfg-lt-barra" style="width:${pct(c.total)};">
              <span class="fase exec" style="flex:${c.d.exec};" title="Execução: ${per(c.exec)} (${c.d.exec} dias)">${cad(o.exec)}</span>
              <span class="fase doc" style="flex:${c.d.doc};" title="Emissão de documento: ${per(c.doc)} (${c.d.doc} dias)">Documento</span>
              <span class="fase nf" style="flex:${c.d.nf};" title="Emissão da NF: ${per(c.nf)}">NF</span>
            </div>
            <span class="nfg-lt-total" style="left:${pct(c.total)};">${c.total} dias</span>
            <i class="nfg-lt-hoje" style="left:${pct(c.hojeDia + 0.5)};" title="Hoje — dia ${c.hojeDia + 1} do ciclo"></i>
          </div>
          <div class="nfg-lt-datas">Ciclo atual: <b>execução</b> ${per(c.exec)} → <b>documento</b> ${per(c.doc)} → <b>NF</b> ${per(c.nf)}</div>
        </div>`).join("")}
    </div>
    <div class="hint" style="margin:10px 0 0;">Passe o mouse (ou toque) numa fase para ver as datas. Lead time = dias corridos do início da execução até a emissão da NF.</div>
  </div>`;
}

// Painel Gerencial: item próprio no menu (só Diretor)
initCharts.gerencial = () => nfgGrafico();
renderers.gerencial = () => `<div class="page-head nfg-head"><div><h2>Painel Gerencial</h2><p>Todas as operações e o status de cada uma — da operação ao recebimento da NF · a baixa do recebimento é da Diretoria</p></div>
  <button class="nfg-lt-btn" onclick="nfgLtAbrir()"><span>🗓️</span><span><b>Calendário de lead time</b><small>prazos de cada operação</small></span></button></div>` + nfgPagina();
renderers.emissaonf = () => {
  if(MEU_PAPEL === "manutencao") return `<div class="page-head"><h2>O.S de Manutenção</h2></div>
    <div class="panel"><div class="empty-state" style="padding:24px;"><div class="glyph">🔧</div><h4>Esta tela foi desativada</h4><p>A O.S de Manutenção foi retirada do sistema. Fale com a diretoria.</p></div></div>`;
  // perfil Operação (Pré O.S): só o plano do dia — lança e valida as Pré O.S, sem valores e sem as O.S
  if(MEU_PAPEL === "preos"){ NF_ABA = "os"; oseGarantirCarga();
    return `<div class="page-head"><h2>Pré O.S — plano do dia</h2><p>Lance o que será feito em cada carreta; no fim do dia o líder valida cada Pré O.S e ela vai para a administração</p></div>`
      + (OSE.erro ? `<div class="panel"><div class="empty-state" style="padding:24px;"><div class="glyph">⚠️</div><p>${osEsc(OSE.erro)}</p></div></div>`
        : !OSE.carregado ? `<div class="panel"><div class="empty-state" style="padding:24px;"><p>Carregando...</p></div></div>`
        : `${oseEditorHTML()}${osePlanoHTML()}`); }
  if(MEU_PAPEL === "administrativo") NF_ABA = "os";   // perfil Administrativo: só a Emissão de O.S
  if(!["nf","nfe","os"].includes(NF_ABA)) NF_ABA = "nf";
  const abas = `
    <div class="tabs" style="margin-bottom:14px;">
      <button class="tab-btn ${NF_ABA==="nf"?"active":""}" onclick="setNfAba('nf')">🧾 Contratos</button>
      <button class="tab-btn ${NF_ABA==="nfe"?"active":""}" onclick="setNfAba('nfe')">📑 NF Emitidas</button>
      <button class="tab-btn ${NF_ABA==="os"?"active":""}" onclick="setNfAba('os')">🛠️ Emissão de O.S</button>
    </div>`;
  if(NF_ABA === "os") return `<div class="page-head"><h2>Emissão de O.S</h2><p>Pré O.S lançadas pela operação no planejamento do dia → conferência do administrativo → O.S para a Combitrans</p></div>` + (MEU_PAPEL === "administrativo" ? "" : abas) + osePagina();
  const cab = NF_ABA === "nfe"
    ? `<div class="page-head"><h2>NF Emitidas</h2><p>Notas fiscais emitidas por atividade — número, NF, valor, data de emissão e observação</p></div>`
    : `<div class="page-head"><h2>Emissão de NF</h2><p>Lançamento das notas por contrato — serviço ou balsa, deadline, entrega da minuta e vencimento · mesmos dados da tela Faturamento</p></div>`;
  return cab + abas + (NF_ABA === "nfe" ? nfePagina() : nfPaginaNotas());
};
initCharts.emissaonf = () => { if(NF_ABA === "nfe") nfeGrafico(); };
/* -------------------- ORGANOGRAMA (Pessoas · só Diretoria) --------------------
   Colaboradores com foto, função, local, data de admissão e a quem respondem (gestor). Dados na tabela
   "colaboradores" do banco (acesso só do Diretor) — nada de dado pessoal no código do site. Fotos são
   reduzidas no navegador (160x160 JPEG) e gravadas junto do cadastro. Desligar tira a pessoa do
   organograma e guarda no histórico de desligados (com data e motivo), podendo reativar depois.
   A carga inicial (94 pessoas do organograma de setembro) é importada uma vez de um arquivo .json. */
const ORG_LOCAIS_PADRAO = [
  { nome:"Diretoria",           cor:"#17181C" },
  { nome:"Administração",       cor:"#5B5F6B" },
  { nome:"Entregas 1T",         cor:"#2E6DB0" },
  { nome:"Entregas/Honda 1T",   cor:"#4A86C8" },
  { nome:"Moto Honda 1T",       cor:"#D0021B" },
  { nome:"Porto 1T",            cor:"#1C9A6C" },
  { nome:"Moto Honda 2T",       cor:"#8C0011" },
  { nome:"Porto 2T",            cor:"#147A55" },
  { nome:"Mecânica",            cor:"#E1971F" },
  { nome:"Manutenção Carreta",  cor:"#B87410" },
  { nome:"Intermediário",       cor:"#8E2EB0" },
  { nome:"Operação Belém",      cor:"#C9A227" },
];
const ORG_CORES_EXTRAS = ["#0F6E8C","#6B4E9B","#A0522D","#2F7D32","#9E1B5C","#4B5563"];
let ORG = { lista:[], carregado:false, carregando:false, erro:null };
let ORG_VIEW = "arvore", ORG_LOCAL = null, ORG_BUSCA = "", ORG_ABERTOS = null, ORG_ZOOM = 1, ORG_SORT = ["local",1];
let ORG_FICHA = null;          // id em edição | "novo" | null
let ORG_FOTO_NOVA = undefined; // dataURL escolhida na ficha (undefined = não mexeu, null = remover)

function orgAtivos(){ return ORG.lista.filter(p=>p.ativo); }
function orgLocais(){
  const extras = [...new Set(ORG.lista.map(p=>p.local).filter(l=>l && !ORG_LOCAIS_PADRAO.some(x=>x.nome===l)))].sort();
  return [...ORG_LOCAIS_PADRAO, ...extras.map((nome,i)=>({ nome, cor:ORG_CORES_EXTRAS[i % ORG_CORES_EXTRAS.length] }))];
}
const orgCor = (l) => (orgLocais().find(x=>x.nome===l)||{ cor:"#5B5F6B" }).cor;
const orgHoje = () => frotaHojeISO();
function orgTempoCasa(iso){
  if(!iso) return "—";
  const hoje = nfeDate(orgHoje()), d = nfeDate(iso);
  let m = (hoje.getFullYear()-d.getFullYear())*12 + hoje.getMonth()-d.getMonth(); if(hoje.getDate()<d.getDate()) m--;
  if(m<1) return `${Math.max(0, nfeDias(iso, orgHoje()))} dias`;
  const a = Math.floor(m/12), r = m%12;
  return [a?`${a} ano${a>1?"s":""}`:"", r?`${r} ${r>1?"meses":"mês"}`:""].filter(Boolean).join(" e ");
}
const orgExperiencia = (p) => { if(!p.adm) return false; const d = nfeDias(p.adm, orgHoje()); return d>=0 && d<=90; };
function orgAvatar(p, cls=""){
  const ini = (p.nome||"?").split(" ").map(s=>s[0]).slice(0,2).join("").toUpperCase();
  return p.foto ? `<img class="og-av ${cls}" src="${p.foto}" alt="">` : `<div class="og-av ${cls}">${osEsc(ini)}</div>`;
}
const orgFilhos = (id) => orgAtivos().filter(p=>p.gestorId===id);
function orgEquipeTotal(id, vistos=new Set()){ if(vistos.has(id)) return 0; vistos.add(id); return orgFilhos(id).reduce((n,f)=>n+1+orgEquipeTotal(f.id, vistos),0); }
function orgDescendentes(id, acc=new Set()){ orgFilhos(id).forEach(f=>{ if(!acc.has(f.id)){ acc.add(f.id); orgDescendentes(f.id, acc); } }); return acc; }
function orgBate(p){
  const q = nfSemAcento(ORG_BUSCA);
  return (!q || nfSemAcento(`${p.nome} ${p.funcao}`).includes(q)) && (!ORG_LOCAL || p.local===ORG_LOCAL);
}
const orgFiltrando = () => !!(ORG_BUSCA.trim() || ORG_LOCAL);

/* ---------- Banco ---------- */
function orgDoBanco(r){ return { id:r.id, nome:r.nome, funcao:r.funcao||"", local:r.local||"", gestorId:r.gestor_id||null, adm:r.data_admissao||"", foto:r.foto||"",
  ativo:r.ativo!==false, deslData:r.data_desligamento||"", deslMotivo:r.motivo_desligamento||"", obs:r.obs||"", ordem:r.ordem||0 }; }
function orgParaBanco(p){ return { id:p.id, nome:p.nome, funcao:p.funcao||null, local:p.local||null, gestor_id:p.gestorId||null, data_admissao:p.adm||null, foto:p.foto||null,
  ativo:p.ativo, data_desligamento:p.deslData||null, motivo_desligamento:p.deslMotivo||null, obs:p.obs||null, ordem:p.ordem||0,
  atualizado_por:MEU_EMAIL||null, atualizado_em:new Date().toISOString() }; }
async function orgCarregar(){
  ORG.carregando = true;
  if(!sb){ try{ ORG.lista = JSON.parse(localStorage.getItem("avance_organograma_local")||"[]"); }catch(e){ ORG.lista = []; } }
  else {
    const { data, error } = await sb.from("colaboradores").select("*").order("ordem");
    if(error){ ORG.erro = error.message; ORG.carregando = false; ORG.carregado = true; orgRerender(); return; }
    ORG.erro = null; ORG.lista = data.map(orgDoBanco);
  }
  ORG.carregando = false; ORG.carregado = true; orgRerender();
}
function orgSalvarLocal(){ if(!sb) try{ localStorage.setItem("avance_organograma_local", JSON.stringify(ORG.lista)); }catch(e){ toast("⚠ Sem espaço para salvar fotos no modo local."); } }
async function orgGravar(lista){
  if(sb){ const { error } = await sb.from("colaboradores").upsert(lista.map(orgParaBanco)); if(error){ toast("⚠ Não salvou: " + error.message); return false; } }
  lista.forEach(p=>{ const i = ORG.lista.findIndex(x=>x.id===p.id); if(i>=0) ORG.lista[i] = p; else ORG.lista.push(p); });
  orgSalvarLocal(); return true;
}
function orgRerender(){ if(document.querySelector('nav.menu button.active')?.dataset.page === "organograma"){ document.getElementById("content").innerHTML = renderers.organograma(); orgDepoisDeDesenhar(); } }

/* ---------- Importação da carga inicial ---------- */
window.orgImportar = async () => {
  const file = document.getElementById("og-carga")?.files[0], st = document.getElementById("og-carga-st");
  if(!file){ st.textContent = "⚠ Escolha o arquivo Organograma_Avance_CARGA_sistema.json"; return; }
  try{
    const carga = JSON.parse(await file.text());
    if(carga.tipo !== "avance-organograma" || !Array.isArray(carga.colaboradores)){ st.textContent = "⚠ Esse arquivo não é a carga do organograma."; return; }
    if(ORG.lista.length && !confirm(`Já existem ${ORG.lista.length} colaboradores cadastrados. Importar mesmo assim? (pessoas já existentes, pelo mesmo código, são atualizadas)`)) return;
    st.textContent = `Gravando ${carga.colaboradores.length} colaboradores...`;
    const lista = carga.colaboradores.map(r=>orgDoBanco(r));
    if(sb){
      // 1ª etapa: grava todo mundo SEM o gestor (o gestor pode vir depois no arquivo e o banco
      // recusaria apontar para alguém que ainda não existe); 2ª etapa: liga cada um ao seu gestor.
      for(let i=0;i<lista.length;i+=25){
        const { error } = await sb.from("colaboradores").upsert(lista.slice(i,i+25).map(p=>({ ...orgParaBanco(p), gestor_id:null })));
        if(error){ st.textContent = "⚠ " + error.message; return; }
        st.textContent = `Gravando pessoas... ${Math.min(i+25, lista.length)} de ${lista.length}`;
      }
      for(let i=0;i<lista.length;i+=25){
        const { error } = await sb.from("colaboradores").upsert(lista.slice(i,i+25).map(orgParaBanco));
        if(error){ st.textContent = "⚠ " + error.message; return; }
        st.textContent = `Ligando cada um ao seu gestor... ${Math.min(i+25, lista.length)} de ${lista.length}`;
      }
    }
    ORG.lista = lista; orgSalvarLocal(); ORG_ABERTOS = null;
    toast(`✓ ${lista.length} colaboradores importados`); orgRerender();
  }catch(e){ st.textContent = "⚠ Erro ao ler o arquivo: " + (e.message||e); }
};

/* ---------- Ações de tela ---------- */
window.orgSetView = (v) => { ORG_VIEW = v; orgRerender(); };
window.orgSetLocal = (l) => { ORG_LOCAL = ORG_LOCAL===l ? null : l; orgRerender(); };
window.orgBuscar = (t) => { ORG_BUSCA = t; orgRerender(); const el = document.getElementById("og-busca"); if(el){ el.focus(); el.setSelectionRange(t.length,t.length); } };
window.orgAlternar = (id) => { ORG_ABERTOS.has(id) ? ORG_ABERTOS.delete(id) : ORG_ABERTOS.add(id); orgRerender(); };
window.orgAbrirTudo = (sim) => { ORG_ABERTOS = new Set(sim ? orgAtivos().filter(p=>orgFilhos(p.id).length).map(p=>p.id) : orgAtivos().filter(p=>!p.gestorId).map(p=>p.id)); if(sim && ORG_ZOOM===1) ORG_ZOOM = 0.6; orgRerender(); };
window.orgZoom = (d) => { ORG_ZOOM = d===0 ? 1 : Math.min(1.4, Math.max(0.4, +(ORG_ZOOM+d).toFixed(1))); orgRerender(); };
window.orgOrdenar = (k) => { ORG_SORT = [k, ORG_SORT[0]===k ? -ORG_SORT[1] : 1]; orgRerender(); };
function orgDepoisDeDesenhar(){
  const w = document.querySelector(".og-wrap"), r = w && w.querySelector(".og-node");
  if(w && r){ const a = w.getBoundingClientRect(), b = r.getBoundingClientRect(); w.scrollLeft += (b.left + b.width/2) - (a.left + a.width/2); }
}

/* ---------- Ficha (cadastro / edição / desligamento) ---------- */
window.orgAbrirFicha = (id) => { ORG_FICHA = id; ORG_FOTO_NOVA = undefined; orgDesenharFicha(); };
window.orgNovo = () => orgAbrirFicha("novo");
window.orgFecharFicha = () => { ORG_FICHA = null; document.getElementById("og-ficha")?.classList.remove("aberta"); document.getElementById("og-fundo")?.classList.remove("aberta"); };
function orgDesenharFicha(){
  const novo = ORG_FICHA === "novo";
  const p = novo ? { id:"", nome:"", funcao:"", local:ORG_LOCAL||"", gestorId:null, adm:"", foto:"", ativo:true, obs:"" } : ORG.lista.find(x=>x.id===ORG_FICHA);
  if(!p) return;
  const foto = ORG_FOTO_NOVA === undefined ? p.foto : (ORG_FOTO_NOVA || "");
  const proibidos = novo ? new Set() : new Set([p.id, ...orgDescendentes(p.id)]);
  const gestores = orgAtivos().filter(x=>!proibidos.has(x.id)).sort((a,b)=>a.nome.localeCompare(b.nome,"pt-BR"));
  const g = ORG.lista.find(x=>x.id===p.gestorId), eq = novo ? 0 : orgEquipeTotal(p.id);
  const f = document.getElementById("og-ficha"); if(!f) return;
  f.style.setProperty("--c", orgCor(p.local));
  f.innerHTML = `
    <div class="og-topo"><button class="og-x" onclick="orgFecharFicha()">✕</button>
      ${orgAvatar({ ...p, foto })}
      <h2>${novo ? "Novo colaborador" : osEsc(p.nome)}</h2><p>${osEsc(p.funcao)||"&nbsp;"}</p>
      ${!p.ativo ? `<span class="badge red">desligado em ${fmtDataBR(p.deslData)}</span>` : ""}
    </div>
    <div class="og-campos os-form">
      <label>Foto<div class="og-foto-acoes">
        <input type="file" id="og-foto" accept="image/*" onchange="orgEscolherFoto(this)">
        ${foto ? `<button class="os-link" onclick="orgRemoverFoto()">remover foto</button>` : ""}</div></label>
      <label>Nome<input id="og-nome" value="${osEsc(p.nome)}" placeholder="Nome do colaborador"></label>
      <label>Função<input id="og-funcao" list="og-l-funcoes" value="${osEsc(p.funcao)}" placeholder="ex: Motorista">
        <datalist id="og-l-funcoes">${[...new Set(ORG.lista.map(x=>x.funcao).filter(Boolean))].sort().map(x=>`<option value="${osEsc(x)}">`).join("")}</datalist></label>
      <label>Local<select id="og-local" onchange="if(this.value==='__novo'){ const n=(prompt('Nome do novo local:')||'').trim(); if(n){ const o=document.createElement('option'); o.text=n; o.value=n; this.add(o, this.options.length-1); this.value=n; } else this.value=''; }">
        <option value="">Selecione</option>${orgLocais().map(l=>`<option ${l.nome===p.local?"selected":""}>${osEsc(l.nome)}</option>`).join("")}<option value="__novo">+ novo local…</option></select></label>
      <label>Responde a<select id="og-gestor"><option value="">— ninguém (topo do organograma)</option>${gestores.map(x=>`<option value="${x.id}" ${x.id===p.gestorId?"selected":""}>${osEsc(x.nome)} · ${osEsc(x.funcao)}</option>`).join("")}</select></label>
      <label>Data de admissão<input type="date" id="og-adm" value="${p.adm||""}"></label>
      <label>Observação<input id="og-obs" value="${osEsc(p.obs)}" placeholder="opcional"></label>
      ${!novo ? `<div class="og-info"><span>Tempo de casa</span><b>${orgTempoCasa(p.adm)}${orgExperiencia(p) ? ' <span class="og-novo">EM EXPERIÊNCIA</span>' : ""}</b></div>
        <div class="og-info"><span>Responde hoje a</span><b>${g ? osEsc(g.nome) : "—"}</b></div>
        ${eq ? `<div class="og-info"><span>Equipe</span><b>${eq} pessoa(s)</b></div>` : ""}` : ""}
    </div>
    <div class="og-btns">
      <button class="entry-submit" style="margin:0;" onclick="orgSalvarFicha()">${novo ? "Cadastrar" : "Salvar"}</button>
      <button class="os-btn" onclick="orgFecharFicha()">Fechar</button>
      ${!novo && p.ativo ? `<button class="os-btn red" style="margin-left:auto;" onclick="orgPedirDesligamento()">Desligar</button>` : ""}
      ${!novo && !p.ativo ? `<button class="os-btn green" style="margin-left:auto;" onclick="orgReativar('${p.id}')">Reativar</button>` : ""}
    </div>
    <div id="og-desl" class="og-desl" style="display:none;">
      <h4>Desligar ${osEsc(p.nome)}</h4>
      <label>Data do desligamento<input type="date" id="og-desl-data" value="${orgHoje()}"></label>
      <label>Motivo<select id="og-desl-motivo"><option>Pedido de demissão</option><option>Dispensa sem justa causa</option><option>Dispensa com justa causa</option><option>Término de contrato / experiência</option><option>Acordo</option><option>Outros</option></select></label>
      ${eq ? `<div class="os-alerta amber">A equipe de ${osEsc(p.nome)} (${orgFilhos(p.id).length} pessoa(s) direta(s)) passa a responder a <b>${g ? osEsc(g.nome) : "ninguém"}</b>.</div>` : ""}
      <button class="os-btn red" onclick="orgConfirmarDesligamento('${p.id}')">Confirmar desligamento</button>
    </div>`;
  f.classList.add("aberta"); document.getElementById("og-fundo")?.classList.add("aberta");
}
// Foto: recorta no centro e reduz para 160x160 (JPEG), para o cadastro ficar leve
window.orgEscolherFoto = (inp) => {
  const file = inp.files[0]; if(!file) return;
  const img = new Image(), url = URL.createObjectURL(file);
  img.onload = () => {
    const lado = Math.min(img.width, img.height), c = document.createElement("canvas"); c.width = c.height = 160;
    c.getContext("2d").drawImage(img, (img.width-lado)/2, (img.height-lado)/2, lado, lado, 0, 0, 160, 160);
    ORG_FOTO_NOVA = c.toDataURL("image/jpeg", 0.78); URL.revokeObjectURL(url);
    const dados = orgLerFicha(); orgDesenharFicha(); orgPreencherFicha(dados);
  };
  img.onerror = () => toast("⚠ Não consegui abrir essa imagem.");
  img.src = url;
};
window.orgRemoverFoto = () => { ORG_FOTO_NOVA = null; const d = orgLerFicha(); orgDesenharFicha(); orgPreencherFicha(d); };
function orgLerFicha(){ const g = (id)=>document.getElementById(id)?.value ?? ""; return { nome:g("og-nome"), funcao:g("og-funcao"), local:g("og-local"), gestor:g("og-gestor"), adm:g("og-adm"), obs:g("og-obs") }; }
function orgPreencherFicha(d){ const s = (id,v)=>{ const el = document.getElementById(id); if(el && v!=null) el.value = v; }; s("og-nome", d.nome); s("og-funcao", d.funcao); s("og-local", d.local); s("og-gestor", d.gestor); s("og-adm", d.adm); s("og-obs", d.obs); }
window.orgSalvarFicha = async () => {
  const d = orgLerFicha(), novo = ORG_FICHA === "novo";
  if(!d.nome.trim()){ toast("Informe o nome."); return; }
  if(!d.local || d.local==="__novo"){ toast("Escolha o local."); return; }
  const base = novo ? { id:crypto.randomUUID(), ativo:true, foto:"", ordem:Math.max(0, ...ORG.lista.map(x=>x.ordem||0))+1, deslData:"", deslMotivo:"" } : { ...ORG.lista.find(x=>x.id===ORG_FICHA) };
  const p = { ...base, nome:d.nome.trim(), funcao:d.funcao.trim(), local:d.local, gestorId:d.gestor||null, adm:d.adm||"", obs:d.obs.trim() };
  if(ORG_FOTO_NOVA !== undefined) p.foto = ORG_FOTO_NOVA || "";
  if(await orgGravar([p])){ toast(novo ? `${p.nome} cadastrado(a) ✓` : `${p.nome} atualizado(a) ✓`); if(ORG_ABERTOS && p.gestorId) ORG_ABERTOS.add(p.gestorId); orgFecharFicha(); orgRerender(); }
};
window.orgPedirDesligamento = () => { const el = document.getElementById("og-desl"); if(el){ el.style.display = "block"; el.scrollIntoView({ behavior:"smooth" }); } };
window.orgConfirmarDesligamento = async (id) => {
  const p = ORG.lista.find(x=>x.id===id); if(!p) return;
  const data = document.getElementById("og-desl-data")?.value || orgHoje(), motivo = document.getElementById("og-desl-motivo")?.value || "";
  const mudar = orgFilhos(id).map(f=>({ ...f, gestorId:p.gestorId || null }));      // equipe sobe para o gestor dele
  const desligado = { ...p, ativo:false, deslData:data, deslMotivo:motivo };
  if(await orgGravar([desligado, ...mudar])){ toast(`${p.nome} desligado(a) em ${fmtDataBR(data)}`); orgFecharFicha(); orgRerender(); }
};
window.orgReativar = async (id) => {
  const p = ORG.lista.find(x=>x.id===id); if(!p) return;
  const gestorOk = p.gestorId && ORG.lista.some(x=>x.id===p.gestorId && x.ativo);
  if(await orgGravar([{ ...p, ativo:true, deslData:"", deslMotivo:"", gestorId: gestorOk ? p.gestorId : null }])){ toast(`${p.nome} reativado(a) ✓${gestorOk ? "" : " — confira a quem ele(a) responde"}`); orgFecharFicha(); orgRerender(); }
};
window.orgExcluir = async (id) => {
  const p = ORG.lista.find(x=>x.id===id); if(!p || !confirm(`Excluir DEFINITIVAMENTE o cadastro de ${p.nome}? Isso não pode ser desfeito.`)) return;
  if(sb){ const { error } = await sb.from("colaboradores").delete().eq("id", id); if(error){ toast("⚠ Não excluiu: " + error.message); return; } }
  ORG.lista = ORG.lista.filter(x=>x.id!==id); orgSalvarLocal(); orgRerender();
};

/* ---------- Visões ---------- */
function orgNo(p){
  const fs = orgFilhos(p.id), gestores = fs.filter(f=>orgFilhos(f.id).length), folhas = fs.filter(f=>!orgFilhos(f.id).length);
  const aberto = ORG_ABERTOS.has(p.id) || orgFiltrando(), total = orgEquipeTotal(p.id);
  const cls = orgFiltrando() ? (orgBate(p) ? "og-match" : "og-apagado") : "";
  const card = `<div class="og-node ${cls}" style="--c:${orgCor(p.local)}" onclick="orgAbrirFicha('${p.id}')">
      ${orgAvatar(p)}<div><div class="og-nm">${osEsc(p.nome)}</div><div class="og-fn">${osEsc(p.funcao)}</div><div class="og-dt">${fmtDataBR(p.adm)}</div></div>
      ${total ? `<button class="og-tg" onclick="event.stopPropagation(); orgAlternar('${p.id}')">${aberto?"▲":"▼"} ${total}</button>` : ""}</div>`;
  if(!fs.length || !aberto) return `<li>${card}</li>`;
  const porLocal = {}; folhas.forEach(f=>{ (porLocal[f.local] = porLocal[f.local] || []).push(f); });
  const ordemLocal = orgLocais().map(l=>l.nome);
  const colunas = Object.entries(porLocal).sort((a,b)=>ordemLocal.indexOf(a[0])-ordemLocal.indexOf(b[0])).map(([loc, ps])=>`
    <li><div class="og-equipe" style="--c:${orgCor(loc)}"><h4>${osEsc(loc)}<span>${ps.length}</span></h4>
      ${ps.sort((a,b)=>(a.ordem||0)-(b.ordem||0)).map(f=>`<div class="og-pessoa ${orgFiltrando() ? (orgBate(f) ? "og-match" : "og-apagado") : ""}" style="--c:${orgCor(f.local)}" onclick="orgAbrirFicha('${f.id}')">${orgAvatar(f,"sm")}
        <div><div class="og-nm">${osEsc(f.nome)}${orgExperiencia(f)?'<span class="og-novo">NOVO</span>':""}</div><div class="og-dt">${osEsc(f.funcao)} · ${fmtDataBR(f.adm)}</div></div></div>`).join("")}
    </div></li>`).join("");
  return `<li>${card}<ul>${gestores.map(orgNo).join("")}${colunas}</ul></li>`;
}
function orgViewArvore(){
  const ids = new Set(orgAtivos().map(p=>p.id));
  const raiz = orgAtivos().filter(p=>!p.gestorId || !ids.has(p.gestorId));
  return `<div class="og-ctrl"><button class="os-btn sm" onclick="orgAbrirTudo(true)">⊕ Abrir tudo</button><button class="os-btn sm" onclick="orgAbrirTudo(false)">⊖ Recolher</button>
      <button class="os-btn sm" onclick="orgZoom(-0.1)">－</button><button class="os-btn sm" onclick="orgZoom(0)">${Math.round(ORG_ZOOM*100)}%</button><button class="os-btn sm" onclick="orgZoom(0.1)">＋</button></div>
    <div class="og-wrap"><div class="og-tree" style="zoom:${ORG_ZOOM}"><ul>${raiz.map(orgNo).join("")}</ul></div></div>`;
}
function orgViewLocais(){
  const ativos = orgAtivos(), locais = orgLocais().filter(l=>ativos.some(p=>p.local===l.nome));
  const max = Math.max(1, ...locais.map(l=>ativos.filter(p=>p.local===l.nome).length));
  return `<div class="panel" style="margin-bottom:16px;"><h3>Resumo por local — ${ativos.length} colaboradores</h3>
    ${locais.map(l=>{ const n = ativos.filter(p=>p.local===l.nome).length; return `<div class="og-rb" style="--c:${l.cor}" onclick="orgSetLocal('${osEsc(l.nome)}')"><span>${osEsc(l.nome)}</span><div class="og-rt"><div style="width:${n/max*100}%"></div></div><b>${n}</b></div>`; }).join("")}
  </div>
  <div class="og-setores">${locais.filter(l=>!ORG_LOCAL || l.nome===ORG_LOCAL).map(l=>{ const ps = ativos.filter(p=>p.local===l.nome && orgBate(p)); const lider = ativos.find(p=>p.local===l.nome && /l[íi]der/i.test(p.funcao));
    return `<div class="og-setor" style="--c:${l.cor}"><div class="og-cab"><div><b>${osEsc(l.nome)}</b><small>${lider ? `Líder: ${osEsc(lider.nome)}` : ""}</small></div><span class="og-q">${ps.length}</span></div>
      ${ps.map(f=>`<div class="og-pessoa" style="--c:${l.cor}" onclick="orgAbrirFicha('${f.id}')">${orgAvatar(f,"sm")}<div><div class="og-nm">${osEsc(f.nome)}${orgExperiencia(f)?'<span class="og-novo">NOVO</span>':""}</div><div class="og-dt">${osEsc(f.funcao)} · ${fmtDataBR(f.adm)} · ${orgTempoCasa(f.adm)}</div></div></div>`).join("") || '<div class="hint" style="padding:12px;">Ninguém encontrado</div>'}
    </div>`; }).join("")}</div>`;
}
function orgViewLista(desligados){
  const [k, dir] = ORG_SORT, ordemLocal = orgLocais().map(l=>l.nome);
  const base = desligados ? ORG.lista.filter(p=>!p.ativo) : orgAtivos().filter(orgBate);
  const val = (p) => k==="local" ? ordemLocal.indexOf(p.local) : k==="adm" ? (p.adm||"9") : k==="desl" ? (p.deslData||"") : nfSemAcento(p[k]||"");
  const ord = base.sort((a,b)=>(val(a)>val(b)?1:val(a)<val(b)?-1:0)*dir || a.nome.localeCompare(b.nome,"pt-BR"));
  const th = (key,l) => `<th onclick="orgOrdenar('${key}')" style="cursor:pointer;">${l}${k===key?(dir>0?" ▲":" ▼"):""}</th>`;
  if(!ord.length) return `<div class="panel"><div class="empty-state" style="padding:20px;"><p>${desligados ? "Nenhum desligado." : "Ninguém encontrado."}</p></div></div>`;
  return `<div class="panel"><div style="overflow-x:auto;"><table class="nf-tab">
    <thead><tr><th></th>${th("nome","Nome")}${th("funcao","Função")}${th("local","Local")}${th("adm","Admissão")}${desligados ? th("desl","Desligamento")+"<th>Motivo</th><th></th>" : "<th>Tempo de casa</th><th>Responde a</th>"}</tr></thead>
    <tbody>${ord.map(p=>`<tr onclick="orgAbrirFicha('${p.id}')" style="cursor:pointer;"><td style="width:46px;">${orgAvatar(p,"sm").replace('class="og-av','style="--c:'+orgCor(p.local)+'" class="og-av')}</td>
      <td><b>${osEsc(p.nome)}</b>${!desligados && orgExperiencia(p)?'<span class="og-novo">NOVO</span>':""}</td><td>${osEsc(p.funcao)}</td>
      <td><span class="og-badge" style="--c:${orgCor(p.local)}"><i></i>${osEsc(p.local)}</span></td><td>${fmtDataBR(p.adm)}</td>
      ${desligados ? `<td>${fmtDataBR(p.deslData)}</td><td>${osEsc(p.deslMotivo)}</td><td style="white-space:nowrap;"><button class="os-btn sm green" onclick="event.stopPropagation(); orgReativar('${p.id}')">Reativar</button> <button class="os-link" onclick="event.stopPropagation(); orgExcluir('${p.id}')">excluir</button></td>`
        : `<td>${orgTempoCasa(p.adm)}</td><td>${osEsc((ORG.lista.find(g=>g.id===p.gestorId)||{}).nome||"—")}</td>`}</tr>`).join("")}</tbody>
  </table></div></div>`;
}

renderers.organograma = () => {
  if(!ORG.carregado && !ORG.carregando){ ORG.carregando = true; setTimeout(()=>orgCarregar(), 0); }
  const cab = `<div class="page-head"><h2>Organograma</h2><p>Colaboradores por local, função e liderança — só a Diretoria vê esta tela</p></div>`;
  if(ORG.erro) return cab + `<div class="panel"><div class="empty-state" style="padding:24px;"><div class="glyph">⚠️</div><h4>Não foi possível carregar o organograma</h4><p>${osEsc(ORG.erro)}</p><p>Se falar em tabela inexistente ("colaboradores"), rode o SQL do organograma no Supabase.</p></div></div>`;
  if(ORG.carregando && !ORG.lista.length) return cab + `<div class="panel"><div class="empty-state" style="padding:24px;"><div class="glyph">⏳</div><p>Carregando...</p></div></div>`;
  const ativos = orgAtivos();
  if(!ORG_ABERTOS){ ORG_ABERTOS = new Set(ativos.filter(p=>!p.gestorId || ["Coordenação Geral"].includes(p.funcao)).map(p=>p.id)); }
  const importar = `
    <details class="panel" style="margin-bottom:16px;" ${ORG.lista.length ? "" : "open"}>
      <summary style="cursor:pointer; font-weight:700;">📥 Importar carga inicial ${ORG.lista.length ? "" : '<span class="badge amber">faça isso uma vez para começar</span>'}</summary>
      <div class="hint" style="margin-top:8px;">Escolha o arquivo <b>Organograma_Avance_CARGA_sistema.json</b> (pasta Desktop › 3-Avance › RH). Ele traz as 94 pessoas do organograma de setembro, com foto, função, local, admissão e a quem respondem.</div>
      <input type="file" id="og-carga" accept=".json" style="font-size:12.5px;"> <button class="entry-submit" style="margin-top:10px;" onclick="orgImportar()">Importar</button>
      <div id="og-carga-st" class="hint" style="margin-top:8px;"></div>
    </details>`;
  if(!ORG.lista.length) return cab + importar + `<div class="panel"><div class="empty-state" style="padding:24px;"><div class="glyph">🧑‍🤝‍🧑</div><p>Nenhum colaborador cadastrado ainda. Importe a carga inicial acima ou cadastre um a um.</p><button class="entry-submit" onclick="orgNovo()">+ Cadastrar colaborador</button></div></div>`;

  const mot = ativos.filter(p=>/motorista/i.test(p.funcao)).length, lid = ativos.filter(p=>/l[íi]der/i.test(p.funcao)).length;
  const exp = ativos.filter(orgExperiencia), comData = ativos.filter(p=>p.adm);
  const media = comData.length ? sumArr(comData.map(p=>nfeDias(p.adm, orgHoje())))/comData.length/365 : 0;
  const deslig = ORG.lista.filter(p=>!p.ativo), deslig90 = deslig.filter(p=>p.deslData && nfeDias(p.deslData, orgHoje())<=90);
  const aba = (k,l) => `<button class="tab-btn ${ORG_VIEW===k?"active":""}" onclick="orgSetView('${k}')">${l}</button>`;
  const corpo = ORG_VIEW==="locais" ? orgViewLocais() : ORG_VIEW==="lista" ? orgViewLista(false) : ORG_VIEW==="desligados" ? orgViewLista(true) : orgViewArvore();
  return cab + `
    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Colaboradores ativos</div><div class="val">${ativos.length}</div><div class="delta flat">${orgLocais().filter(l=>ativos.some(p=>p.local===l.nome)).length} locais</div></div>
      <div class="kpi"><div class="lbl">Motoristas</div><div class="val">${mot}</div><div class="delta flat">${ativos.length ? (mot/ativos.length*100).toFixed(0) : 0}% do quadro</div></div>
      <div class="kpi"><div class="lbl">Líderes</div><div class="val">${lid}</div><div class="delta flat">${lid ? (mot/lid).toFixed(1).replace(".",",") : "—"} motoristas por líder</div></div>
      <div class="kpi"><div class="lbl">Em experiência</div><div class="val" style="color:var(--green);">${exp.length}</div><div class="delta flat">admitidos há 90 dias ou menos</div></div>
      <div class="kpi"><div class="lbl">Tempo médio de casa</div><div class="val">${media.toFixed(1).replace(".",",")} anos</div><div class="delta flat">${ativos.length-comData.length} sem data</div></div>
      <div class="kpi"><div class="lbl">Desligados (90 dias)</div><div class="val">${deslig90.length}</div><div class="delta flat">${deslig.length} no histórico</div></div>
    </div>
    <div class="panel" style="margin-bottom:12px;">
      <div class="og-barra">
        <input id="og-busca" value="${osEsc(ORG_BUSCA)}" placeholder="🔎 Buscar por nome ou função" oninput="orgBuscar(this.value)">
        <div class="tabs" style="margin:0;">${aba("arvore","🌳 Organograma")}${aba("locais","🧩 Por local")}${aba("lista","📋 Lista")}${aba("desligados",`🗂️ Desligados (${deslig.length})`)}</div>
        <button class="entry-submit" style="margin:0;" onclick="orgNovo()">+ Novo colaborador</button>
      </div>
      <div class="og-chips"><button class="og-chip ${!ORG_LOCAL?"on":""}" style="--c:#17181C" onclick="orgSetLocal(null)">Todos <b>${ativos.length}</b></button>
        ${orgLocais().map(l=>{ const n = ativos.filter(p=>p.local===l.nome).length; return n ? `<button class="og-chip ${ORG_LOCAL===l.nome?"on":""}" style="--c:${l.cor}" onclick="orgSetLocal('${osEsc(l.nome)}')"><i></i>${osEsc(l.nome)} <b>${n}</b></button>` : ""; }).join("")}</div>
    </div>
    ${corpo}
    ${importar}
    <div class="og-fundo" id="og-fundo" onclick="orgFecharFicha()"></div>
    <aside class="og-ficha" id="og-ficha"></aside>`;
};
initCharts.organograma = () => { orgDepoisDeDesenhar(); if(ORG_FICHA) orgDesenharFicha(); };

/* -------------------- EMISSÃO DE O.S (plano do dia → Pré O.S → O.S para a Combitrans) --------------------
   Fluxo, com lançamentos separados na tabela manutencao_os:
     1) PLANO DO DIA — a operação lança as Pré O.S do dia (frota/carreta + serviços da tabela + quantidade).
        status "plano" (ainda editável pela operação)
     2) LÍDER — no fim do dia o líder da operação valida o plano → status "pre" (vai para a administração)
     3) ADMINISTRAÇÃO — no dia seguinte confere cada Pré O.S e gera a O.S (lançamento NOVO, status
        "emitida", pre_id = Pré O.S de origem); a Pré O.S fica "validada", como a operação lançou.
   A O.S sai em PDF no modelo da Avance para a Combitrans e alimenta o ciclo semanal da Combitrans.
   Preços na tabela os_servicos; dados do cabeçalho (Avance e cliente) em app_config — nada disso no
   código do site, que é público. O perfil da oficina não vê valores. */
let OSE = { lista:[], servicos:[], carretas:[], carregado:false, carregando:false, erro:null, cfg:null, cfgSalvo:false };
let OSE_EDIT = null;        // cabeçalho da Pré O.S / O.S aberta no editor
let OSE_ITENS = [];         // serviços em edição
let OSE_FILTRO = "pre";     // pre | validada (lista da administração)
let OSE_PLANO_DIA = frotaHojeISO();
const OSE_LOCAL = "avance_os_emissao_v1";
const OSE_COBRAR = { mo:"Mão de obra", mat:"Peças / material", ambos:"M.O + peças" };
const OSE_ST = {
  plano:    { label:"Em lançamento",           badge:"gray",  icone:"📝" },
  pre:      { label:"Validada pelo líder",     badge:"amber", icone:"📤" },
  validada: { label:"O.S gerada",              badge:"green", icone:"✅" },
};
// Cabeçalho da O.S — lido da foto do modelo; a administração confere e salva (fica no banco)
const OSE_CFG_PADRAO = {
  empresa:"AVANCE LOGÍSTICA INTEGRADA LTDA", razao:"AVANCE LOGÍSTICA INTEGRADA LTDA", cnpj:"50.056.061/0001-49",
  endereco:"Rua Macatuba, Nº 84, Bairro: Cidade de Deus", cep:"69099-266",
  cliente:"COMBITRANS AMAZONAS LTDA", clienteEndereco:"Rua Ponta Grossa, 303 - Col. Oliveira Machado", clienteCnpj:"05.501.594/0002-19",
};
const oseVeValores = () => !["oficina","preos"].includes(MEU_PAPEL);
const osePodeEmitir = () => !sb || ["diretor","coordenacao","administrativo"].includes(MEU_PAPEL);
function oseUn(serv){ return /METRO|\(M\)|MTS/i.test(serv||"") ? "m" : "un"; }
function oseValorItem(it){ const mo = it.cobrar==="mat" ? 0 : (it.mo||0), mat = it.cobrar==="mo" ? 0 : (it.mat||0); return (mo + mat) * (Number(it.qtd)||0); }
function oseValor(o){ return sumArr((o.itens||[]).map(oseValorItem)); }
function oseCobrarPadrao(s){ return s.mo && s.mat ? "ambos" : s.mat && !s.mo ? "mat" : "mo"; }
function oseServico(txt){ const m = String(txt||"").trim().match(/^(\d{1,4})/); return m ? OSE.servicos.find(s=>s.cod===parseInt(m[1],10)) || null : null; }
const oseEhPre = (o) => ["plano","pre","validada"].includes(o.status);
function osePorFila(filaId){ return filaId ? OSE.lista.find(o=>o.filaId===filaId && oseEhPre(o)) || OSE.lista.find(o=>o.filaId===filaId) || null : null; }
function oseDaPre(preId){ return preId ? OSE.lista.find(o=>o.status==="emitida" && o.preId===preId) || null : null; }
function oseCarretas(){ return CAR.carretas.length ? CAR.carretas : OSE.carretas; }
function oseProxNumero(){ const n = OSE.lista.map(o=>Number(o.numero)||0); return (n.length ? Math.max(...n) : 0) + 1; }
function oseCfg(){ return { ...OSE_CFG_PADRAO, ...(OSE.cfg||{}) }; }
const oseBRL = (v) => "R$ " + Number(v||0).toLocaleString("pt-BR", { minimumFractionDigits:2, maximumFractionDigits:2 });
const oseNum = (n) => n ? String(n).padStart(4, "0") : "—";
const oseDiaPlano = (o) => o.dataPlano || o.entrada || "";

async function oseCarregar(){
  OSE.carregando = true;
  if(!sb){ try{ const d = JSON.parse(localStorage.getItem(OSE_LOCAL)||"{}"); OSE.lista = d.lista||[]; if(d.servicos) OSE.servicos = d.servicos; if(d.cfg){ OSE.cfg = d.cfg; OSE.cfgSalvo = true; } }catch(e){} }
  else {
    const t = await sb.from("manutencao_os").select("id,status").limit(1);
    if(t.error){ OSE.erro = t.error.message; OSE.carregando = false; OSE.carregado = true; oseRedesenhar(true); return; }
    OSE.erro = null;
    const [l, s, c, cfg] = await Promise.all([ sbFetchAll("manutencao_os"), OSE.servicos.length ? Promise.resolve(null) : sbFetchAll("os_servicos"),
      CAR.carretas.length || OSE.carretas.length ? Promise.resolve(null) : sbFetchAll("os_carretas"),
      sb.from("app_config").select("valor").eq("chave", "os_cabecalho").maybeSingle() ]);
    OSE.lista = l.map(r=>({ id:r.id, numero:r.numero, status:r.status||"emitida", filaId:r.fila_id||null, preId:r.pre_id||null, dataPlano:r.data_plano||"",
      entrada:r.entrada_data, entradaHora:r.entrada_hora||"", saida:r.saida_data||"", saidaHora:r.saida_hora||"", frota:r.frota||"", placa:r.placa||"",
      itens:r.itens||[], obs:r.obs||"", referencia:r.referencia||"", liderPor:(r.lider_por||"").split("@")[0], liderEm:r.lider_em||"",
      emitidaEm:r.emitida_em||"", emitidaPor:(r.emitida_por||"").split("@")[0], por:(r.criado_por||r.atualizado_por||"").split("@")[0],
      assinadaEm:r.assinada_em||"", nfNumero:r.nf_numero||"", nfId:r.nf_id||null, nfEm:r.nf_em||"" }));
    if(s) OSE.servicos = s.map(x=>({ cod:Number(x.cod), servico:x.servico, grupo:x.grupo||"", mo:x.mo!=null ? Number(x.mo) : null, mat:x.mat!=null ? Number(x.mat) : null })).sort((a,b)=>a.cod-b.cod);
    if(c) OSE.carretas = c.map(x=>({ placa:x.placa, frota:String(x.frota) }));
    if(cfg && !cfg.error && cfg.data && cfg.data.valor){ OSE.cfg = cfg.data.valor; OSE.cfgSalvo = true; }
  }
  OSE.carregando = false; OSE.carregado = true; oseRedesenhar(true);
}
function oseGarantirCarga(){ if(!OSE.carregado && !OSE.carregando){ OSE.carregando = true; setTimeout(()=>oseCarregar(), 0); } }
function oseSalvarLocal(){ if(!sb) try{ localStorage.setItem(OSE_LOCAL, JSON.stringify({ lista:OSE.lista, servicos:OSE.servicos, cfg:OSE.cfgSalvo ? OSE.cfg : null })); }catch(e){} }
// Redesenha a tela onde a O.S aparece (controle diário de carretas ou Emissão de O.S)
function oseRedesenhar(seguro){
  const pg = document.querySelector('nav.menu button.active')?.dataset.page;
  const naCar = pg==="manutencao" && MAN_ABA==="diario", naEmissao = pg==="emissaonf" && NF_ABA==="os";
  if(!naCar && !naEmissao) return;
  if(seguro){ const f = document.activeElement; if(f && f.closest && (f.closest("#ose-form") || f.closest("#ose-cfg")) && /INPUT|SELECT|TEXTAREA/.test(f.tagName)) return; }
  const y = window.scrollY; document.getElementById("content").innerHTML = renderers[pg](); window.scrollTo(0,y);
  if(naCar) requestAnimationFrame(carGrafico);
}
setInterval(()=>{ if(sb && document.visibilityState==="visible" && document.querySelector('nav.menu button.active')?.dataset.page==="emissaonf" && NF_ABA==="os" && !OSE_EDIT) oseCarregar(); }, 60000);

/* ---------- Editor ---------- */
function oseAbrir(dados, itens){ OSE_EDIT = dados; OSE_ITENS = (itens||[]).map(i=>({ ...i })); oseRedesenhar(); setTimeout(()=>document.getElementById("ose-form")?.scrollIntoView({ behavior:"smooth", block:"start" }), 60); }
function osePodeEditarPre(o){ return o.status==="plano" || (o.status==="pre" && osePodeEmitir()); }
// a partir de uma carreta do Controle diário
window.osePreAbrir = (filaId) => {
  const c = CAR.fila.find(x=>x.id===filaId); if(!c) return;
  const o = osePorFila(filaId);
  if(o && !osePodeEditarPre(o)){ const os = o.status==="emitida" ? o : oseDaPre(o.id);
    toast(o.status==="pre" ? "Esta Pré O.S já foi validada pelo líder e está com a administração." : `Esta Pré O.S já virou a O.S ${os ? oseNum(os.numero) : ""}.`); return; }
  oseAbrir(o ? { ...o } : { id:null, filaId, status:"plano", dataPlano:CAR_DIA, numero:null, frota:c.frota, placa:c.placa, entrada:c.entrada, entradaHora:"", saida:c.conclusao||"", saidaHora:"", obs:"" }, o ? o.itens : []);
};
// nova Pré O.S direto no plano do dia (sem passar pela fila do pátio)
window.oseNovaPre = () => { const d = OSE_PLANO_DIA; oseAbrir({ id:null, filaId:null, status:"plano", dataPlano:d, numero:null, frota:"", placa:"", entrada:d, entradaHora:"", saida:"", saidaHora:"", obs:"" }, []); };
window.oseEditarPre = (id) => { const o = OSE.lista.find(x=>x.id===id); if(!o) return; if(!osePodeEditarPre(o)){ toast("Esta Pré O.S não pode mais ser alterada."); return; } oseAbrir({ ...o }, o.itens); };
// administração: Pré O.S validada pelo líder → monta uma O.S NOVA; O.S emitida → edita a própria O.S
window.oseConferir = (id) => {
  const o = OSE.lista.find(x=>x.id===id); if(!o) return;
  if(o.status==="emitida") return oseAbrir({ ...o }, o.itens);
  if(o.status==="validada"){ const os = oseDaPre(o.id); toast(`Esta Pré O.S já virou a O.S ${os ? oseNum(os.numero) : ""}.`); return; }
  if(o.status==="plano"){ toast("O líder ainda não validou este plano."); return; }
  oseAbrir({ id:null, preId:o.id, filaId:o.filaId, status:"nova", numero:oseProxNumero(), frota:o.frota, placa:o.placa, entrada:o.entrada, entradaHora:o.entradaHora||"",
    saida:o.saida, saidaHora:o.saidaHora||"", obs:o.obs, referencia:"", preDe:o.por, liderPor:o.liderPor }, o.itens);
};
window.oseNova = () => oseAbrir({ id:null, preId:null, filaId:null, status:"nova", numero:oseProxNumero(), frota:"", placa:"", entrada:frotaHojeISO(), entradaHora:"", saida:"", saidaHora:"", obs:"", referencia:"" }, []);
window.oseCancelar = () => { OSE_EDIT = null; OSE_ITENS = []; oseRedesenhar(); };
window.oseCampo = (campo, v) => { if(!OSE_EDIT) return; OSE_EDIT[campo] = v;
  if(campo==="frota"){ const t = String(v||"").toUpperCase().trim(), car = oseCarretas().find(x=>x.frota.toUpperCase()===t || x.placa.toUpperCase()===t || carRotulo(x).toUpperCase()===t);
    if(car){ OSE_EDIT.frota = car.frota; OSE_EDIT.placa = car.placa; oseRedesenhar(); } } };
window.oseAddItem = () => {
  const s = oseServico(document.getElementById("ose-serv")?.value);
  if(!s){ toast(OSE.servicos.length ? "Escolha um serviço da lista (código)." : "A tabela de serviços ainda não foi importada."); return; }
  const qtd = parseFloat(String(document.getElementById("ose-qtd")?.value||"1").replace(",", ".")) || 1;
  const ja = OSE_ITENS.find(i=>i.cod===s.cod);
  if(ja){ ja.qtd = (Number(ja.qtd)||0) + qtd; toast(`Somado ao serviço ${s.cod} já lançado.`); }
  else OSE_ITENS.push({ cod:s.cod, servico:s.servico, qtd, un:oseUn(s.servico), mo:s.mo, mat:s.mat, cobrar:oseCobrarPadrao(s) });
  oseRedesenhar(); setTimeout(()=>document.getElementById("ose-serv")?.focus(), 30);
};
window.oseQtd = (i, v) => { const n = parseFloat(String(v).replace(",", ".")); if(n > 0){ OSE_ITENS[i].qtd = n; oseRedesenhar(); } };
window.oseCobrarItem = (i, v) => { OSE_ITENS[i].cobrar = v; oseRedesenhar(); };
window.oseRemover = (i) => { OSE_ITENS.splice(i, 1); oseRedesenhar(); };
window.oseAtualizarPrecos = () => {
  let n = 0; OSE_ITENS.forEach(it=>{ const s = OSE.servicos.find(x=>x.cod===it.cod); if(s && (s.mo!==it.mo || s.mat!==it.mat)){ it.mo = s.mo; it.mat = s.mat; n++; } });
  toast(n ? `${n} preço(s) atualizado(s) pela tabela ✓` : "Os preços já estão iguais à tabela."); oseRedesenhar();
};

window.oseSalvar = async (emitir) => {
  const e = OSE_EDIT; if(!e) return;
  const g = (id) => document.getElementById(id);
  ["frota","placa","entrada","entradaHora","saida","saidaHora","obs","referencia"].forEach(k=>{ if(g(`ose-${k}`)) e[k] = g(`ose-${k}`).value; });
  if(g("ose-numero")) e.numero = parseInt(g("ose-numero").value, 10) || null;
  e.frota = String(e.frota||"").toUpperCase().trim(); e.placa = String(e.placa||"").toUpperCase().trim();
  if(!e.frota){ toast("Informe a frota."); return; }
  if(!e.entrada){ toast("Informe a data de entrada."); return; }
  if(!OSE_ITENS.length){ toast("Lance pelo menos um serviço."); return; }
  if(e.saida && e.saida < e.entrada){ toast("A saída está antes da entrada."); return; }
  if(e.status==="nova" && !emitir) return;
  if(emitir){
    if(!osePodeEmitir()){ toast("A emissão da O.S é feita pela administração."); return; }
    if(!e.numero){ toast("Informe o nº da O.S."); return; }
    if(OSE.lista.some(o=>o.id!==e.id && o.status==="emitida" && Number(o.numero)===e.numero)){ toast(`Já existe a O.S nº ${oseNum(e.numero)}.`); return; }
    if(!e.placa && !confirm("A O.S está sem placa. Emitir assim mesmo?")) return;
  }
  const ehOS = emitir || e.status==="emitida", status = ehOS ? "emitida" : (e.status==="pre" ? "pre" : "plano"), agora = new Date().toISOString();
  const reg = { status, fila_id:e.filaId||null, numero: ehOS ? e.numero : null, entrada_data:e.entrada, entrada_hora:e.entradaHora||null, saida_data:e.saida||null, saida_hora:e.saidaHora||null,
    frota:e.frota, placa:e.placa||null, itens:OSE_ITENS, obs:(e.obs||"").trim()||null, valor:Math.round(sumArr(OSE_ITENS.map(oseValorItem))*100)/100,
    atualizado_por:MEU_EMAIL, atualizado_em:agora,
    ...(ehOS ? { pre_id:e.preId||null, referencia:(e.referencia||"").trim()||null } : { data_plano:e.dataPlano||e.entrada }),
    ...(emitir && e.status!=="emitida" ? { emitida_em:agora, emitida_por:MEU_EMAIL } : {}) };
  let id = e.id;
  if(sb){
    const r = id ? await sb.from("manutencao_os").update(reg).eq("id", id).select("id").single()
                 : await sb.from("manutencao_os").insert({ ...reg, criado_por:MEU_EMAIL }).select("id").single();
    if(r.error){ toast(/status|fila_id|pre_id|data_plano|referencia|valor|emitida|numero|lider/i.test(r.error.message) ? "⚠ Falta rodar o SQL da Emissão de O.S no Supabase." : "⚠ Não salvou: " + r.error.message); return; }
    id = r.data.id;
    if(emitir && e.preId){
      const v = await sb.from("manutencao_os").update({ status:"validada", atualizado_por:MEU_EMAIL, atualizado_em:agora }).eq("id", e.preId);
      if(v.error) toast("⚠ A O.S foi emitida, mas a Pré O.S não foi marcada como validada: " + v.error.message);
    }
  } else if(!id) id = osNovoId();
  if(emitir && e.preId){ const pr = OSE.lista.find(o=>o.id===e.preId); if(pr) pr.status = "validada"; }
  const antigo = OSE.lista.find(o=>o.id===id) || {};
  const local = { ...antigo, id, numero:reg.numero, status, filaId:reg.fila_id, preId: ehOS ? e.preId||null : null, dataPlano: ehOS ? "" : reg.data_plano,
    entrada:reg.entrada_data, entradaHora:reg.entrada_hora||"", saida:reg.saida_data||"", saidaHora:reg.saida_hora||"", frota:reg.frota, placa:reg.placa||"",
    itens:OSE_ITENS.map(i=>({ ...i })), obs:reg.obs||"", referencia: ehOS ? reg.referencia||"" : "",
    emitidaEm: reg.emitida_em || e.emitidaEm || "", emitidaPor: reg.emitida_por ? reg.emitida_por.split("@")[0] : e.emitidaPor || "", por: antigo.por || (MEU_EMAIL||"").split("@")[0] };
  const k = OSE.lista.findIndex(o=>o.id===id); if(k>=0) OSE.lista[k] = local; else OSE.lista.push(local);
  oseSalvarLocal(); OSE_EDIT = null; OSE_ITENS = [];
  toast(emitir && e.status!=="emitida" ? `O.S ${oseNum(local.numero)} emitida ✓${e.preId ? " — Pré O.S validada" : ""}` : ehOS ? "O.S atualizada ✓" : status==="pre" ? "Pré O.S atualizada ✓" : "Pré O.S lançada no plano do dia ✓ — o líder valida no fim do dia");
  if(ehOS) await oseSincronizarCiclo(local.saida || local.entrada);
  oseRedesenhar();
};
// Líder da operação: valida cada Pré O.S individualmente (nominal) → ela vai para a administração
window.oseLiderValidar = async (id) => {
  const o = OSE.lista.find(x=>x.id===id); if(!o || o.status!=="plano") return;
  if(!confirm(`Validar a Pré O.S da frota ${o.frota}${o.placa ? " · " + o.placa : ""} (${o.itens.length} serviço(s)) e enviar para a administração?

Depois disso a operação não altera mais esta Pré O.S.`)) return;
  const agora = new Date().toISOString();
  if(sb){ const { error } = await sb.from("manutencao_os").update({ status:"pre", lider_por:MEU_EMAIL, lider_em:agora, atualizado_por:MEU_EMAIL, atualizado_em:agora }).eq("id", id);
    if(error){ toast(/lider/i.test(error.message) ? "⚠ Falta rodar o SQL da Emissão de O.S no Supabase." : "⚠ Não salvou: " + error.message); return; } }
  o.status = "pre"; o.liderPor = (MEU_EMAIL||"").split("@")[0]; o.liderEm = agora; oseSalvarLocal();
  toast(`Pré O.S da frota ${o.frota} validada ✓ — enviada para a administração`); oseRedesenhar();
};
window.oseReabrir = async (id) => {
  const o = OSE.lista.find(x=>x.id===id); if(!o || o.status!=="pre" || !confirm("Devolver esta Pré O.S para a operação (volta para Em lançamento)?")) return;
  if(sb){ const { error } = await sb.from("manutencao_os").update({ status:"plano", lider_por:null, lider_em:null, atualizado_por:MEU_EMAIL, atualizado_em:new Date().toISOString() }).eq("id", id);
    if(error){ toast("⚠ Não salvou: " + error.message); return; } }
  o.status = "plano"; o.liderPor = ""; o.liderEm = ""; oseSalvarLocal(); oseRedesenhar();
};
window.oseExcluir = async (id) => {
  const o = OSE.lista.find(x=>x.id===id); if(!o) return;
  if(o.status==="emitida" && !osePodeEmitir()){ toast("A O.S já foi emitida."); return; }
  if(o.status==="pre" && !osePodeEmitir()){ toast("Esta Pré O.S já foi validada pelo líder e está com a administração."); return; }
  if(o.status==="validada"){ const os = oseDaPre(o.id); toast(`Esta Pré O.S já virou a O.S ${os ? oseNum(os.numero) : ""}. Exclua a O.S primeiro.`); return; }
  const pre = o.status==="emitida" ? OSE.lista.find(x=>x.id===o.preId) : null;
  if(!confirm(o.status==="emitida" ? `Excluir a O.S ${oseNum(o.numero)} (frota ${o.frota})?${pre ? "\n\nA Pré O.S de origem volta para a conferência da administração." : ""}` : `Excluir a Pré O.S da frota ${o.frota}?`)) return;
  if(sb){ const { error } = await sb.from("manutencao_os").delete().eq("id", id); if(error){ toast("⚠ Não excluiu: " + error.message); return; }
    if(pre){ const v = await sb.from("manutencao_os").update({ status:"pre", atualizado_por:MEU_EMAIL, atualizado_em:new Date().toISOString() }).eq("id", pre.id); if(v.error) toast("⚠ " + v.error.message); } }
  if(pre) pre.status = "pre";
  OSE.lista = OSE.lista.filter(x=>x.id!==id); oseSalvarLocal(); toast(o.status==="emitida" ? `O.S ${oseNum(o.numero)} excluída` : "Pré O.S excluída");
  if(OSE_EDIT && (OSE_EDIT.id===id || OSE_EDIT.preId===id)){ OSE_EDIT = null; OSE_ITENS = []; }
  if(o.status==="emitida") await oseSincronizarCiclo(o.saida || o.entrada, o.numero);
  oseRedesenhar();
};
/* ---------- Depois da emissão: retorno assinado da Combitrans → NF emitida ---------- */
let OSE_OS_FILTRO = "todas";   // todas | aguardando | assinada | nf
let NFE_OS_ID = null;          // O.S que a NF em lançamento (NF Emitidas) vai fechar
const OSE_PRAZO_ASSINATURA = 7;
function oseSituacao(o){
  if(o.nfNumero) return { k:"nf", label:`NF ${o.nfNumero} emitida`, badge:"green", icone:"🧾" };
  if(o.assinadaEm) return { k:"assinada", label:"Assinada — pendente de NF", badge:"amber", icone:"✍️" };
  const lim = o.emitidaEm ? nfeAddDias(o.emitidaEm.slice(0,10), OSE_PRAZO_ASSINATURA) : null, atrasada = !!lim && frotaHojeISO() > lim;
  return { k:"aguardando", label: atrasada ? "Assinatura atrasada" : "Aguardando assinatura", badge: atrasada ? "red" : "gray", icone:"⏳", lim, atrasada };
}
async function oseAtualizarOS(o, campos, local){
  if(sb){ const { error } = await sb.from("manutencao_os").update({ ...campos, atualizado_por:MEU_EMAIL, atualizado_em:new Date().toISOString() }).eq("id", o.id);
    if(error){ toast(/assinada|nf_/i.test(error.message) ? "⚠ Falta rodar o SQL do retorno da O.S (assinatura e NF) no Supabase." : "⚠ Não salvou: " + error.message); return false; } }
  Object.assign(o, local); oseSalvarLocal(); return true;
}
/* ---------- Protocolo de entrega (folha de rosto): faixa de O.S de um dia para a Combitrans assinar ---------- */
let OSE_PROT = null;   // { data, de, ate } enquanto o painel do protocolo está aberto
const oseDiaEmissao = (o) => (o.emitidaEm || "").slice(0,10) || o.entrada || "";
function oseProtFaixa(dia){ const ns = OSE.lista.filter(o=>o.status==="emitida" && oseDiaEmissao(o)===dia).map(o=>Number(o.numero)||0).filter(Boolean).sort((a,b)=>a-b); return ns.length ? { de:ns[0], ate:ns[ns.length-1] } : { de:"", ate:"" }; }
function oseProtLista(){ if(!OSE_PROT) return []; const de = Number(OSE_PROT.de)||0, ate = Number(OSE_PROT.ate)||0;
  return OSE.lista.filter(o=>o.status==="emitida" && Number(o.numero)>=de && Number(o.numero)<=ate).sort((a,b)=>(a.numero||0)-(b.numero||0)); }
window.oseProtAbrir = () => { if(OSE_PROT){ OSE_PROT = null; oseRedesenhar(); return; }
  const d = frotaHojeISO(); OSE_PROT = { data:d, ...oseProtFaixa(d) }; oseRedesenhar(); };
window.oseProtCampo = (k, v) => { if(!OSE_PROT) return; OSE_PROT[k] = v; if(k==="data") Object.assign(OSE_PROT, oseProtFaixa(v)); oseRedesenhar(); };
function oseProtHTML(){
  if(!OSE_PROT) return "";
  const ls = oseProtLista(), faltam = [];
  for(let n = Number(OSE_PROT.de)||0; n && n <= (Number(OSE_PROT.ate)||0) && faltam.length < 30; n++) if(!ls.some(o=>Number(o.numero)===n)) faltam.push(oseNum(n));
  return `<div class="ose-prot">
    <h3 style="margin:0;">📋 Protocolo de entrega — folha de rosto para a Combitrans assinar</h3>
    <div class="hint">Escolha o dia da emissão (a faixa de O.S daquele dia vem sozinha) ou ajuste a faixa de números.</div>
    <div class="nf-grid os-form" style="grid-template-columns:repeat(auto-fit, minmax(160px, 220px)); align-items:end; margin-top:8px;">
      <label>Dia da emissão<input type="date" value="${OSE_PROT.data}" onchange="oseProtCampo('data', this.value)"></label>
      <label>Da O.S nº<input type="number" min="1" value="${OSE_PROT.de}" onchange="oseProtCampo('de', this.value)"></label>
      <label>Até a O.S nº<input type="number" min="1" value="${OSE_PROT.ate}" onchange="oseProtCampo('ate', this.value)"></label>
      <button class="entry-submit" style="margin:0;" onclick="oseProtGerar()" ${ls.length ? "" : "disabled"}>🖨️ Gerar protocolo (PDF)</button>
    </div>
    <div class="hint" style="margin-top:8px;">${ls.length ? `<b>${ls.length}</b> O.S · ${fmtBRL2(sumArr(ls.map(oseValor)))}${faltam.length ? ` · <span style="color:var(--amber);">números sem O.S emitida na faixa: ${faltam.join(", ")}</span>` : ""}` : "Nenhuma O.S emitida nessa faixa."}</div>
  </div>`;
}
window.oseProtGerar = async () => {
  const ls = oseProtLista(); if(!ls.length){ toast("Nenhuma O.S na faixa."); return; }
  if(!oseConfereCfg()) return;
  const aba = window.open("", "_blank");
  try{
    await nfgCarregarPDF();
    const { jsPDF } = window.jspdf, doc = new jsPDF({ unit:"mm", format:"a4" }), W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 12, cfg = oseCfg();
    const total = sumArr(ls.map(oseValor)), de = oseNum(ls[0].numero), ate = oseNum(ls[ls.length-1].numero);
    const diaEm = OSE_PROT.data, nProt = `${diaEm.replace(/-/g,"")}-${de}`;
    oseCabecalhoPDF(doc, 12);
    const X = 12+108, QW = W-12-X;
    doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(20, 20, 26); doc.text(`PROTOCOLO Nº ${nProt}`, X + QW/2, 41.5, { align:"center" });
    doc.setFillColor(235, 235, 238); doc.rect(X, 43.5, QW, 5, "F"); doc.setFont("helvetica", "normal"); doc.setFontSize(8);
    doc.text(`Emissão das O.S: ${fmtDataBR(diaEm)}`, X + QW/2, 47, { align:"center" });
    doc.setDrawColor(40, 40, 46); doc.setLineWidth(0.4); doc.rect(X, 48.5, QW, 10); doc.setFont("helvetica", "bold"); doc.setFontSize(9);
    doc.text(ls.length === 1 ? `O.S nº ${de}` : `O.S nº ${de} a ${ate}`, X + QW/2, 55, { align:"center" });
    doc.setFillColor(20, 20, 26); doc.rect(M, 62, W-2*M, 12, "F");
    doc.setFontSize(14); doc.setTextColor(255, 255, 255); doc.text("PROTOCOLO DE ENTREGA DE ORDENS DE SERVIÇO", W/2, 70, { align:"center" });
    // resumo em destaque
    const caixas = [["Faixa de O.S", ls.length === 1 ? `Nº ${de}` : `Nº ${de} a ${ate}`], ["Dia da emissão", fmtDataBR(diaEm)], ["Quantidade", `${ls.length} O.S`], ["Valor total", oseBRL(total)]];
    const bw = (W - 2*M - 9) / 4;
    caixas.forEach(([l, v], i)=>{ const x = M + i*(bw+3); doc.setFillColor(i===3 ? 255 : 245, i===3 ? 214 : 245, i===3 ? 0 : 247); doc.roundedRect(x, 78, bw, 18, 2, 2, "F");
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(90, 90, 100); doc.text(l.toUpperCase(), x+3, 84);
      doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(20, 20, 26); doc.text(v, x+3, 92); });
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(20, 20, 26);
    const txt = `Entregamos à ${cfg.cliente || "Combitrans"}${cfg.clienteCnpj ? ` (CNPJ ${cfg.clienteCnpj})` : ""} as ordens de serviço de manutenção de carretas relacionadas abaixo, emitidas em ${fmtDataBR(diaEm)}, para análise e assinatura no prazo de até ${OSE_PRAZO_ASSINATURA} dias. A assinatura deste protocolo confirma o recebimento de todas as O.S listadas.`;
    doc.text(doc.splitTextToSize(txt, W-2*M), M, 104);
    doc.autoTable({ startY:116, margin:{ left:M, right:M }, theme:"grid",
      head:[["Nº O.S", "Frota", "Placa", "Início", "Saída", "Serviços", "Valor"]],
      body:ls.map(o=>[oseNum(o.numero), o.frota||"-", o.placa||"-", o.entrada ? fmtDataBR(o.entrada) : "-", o.saida ? fmtDataBR(o.saida) : "-", String((o.itens||[]).length), oseBRL(oseValor(o))]),
      foot:[[{ content:`Total — ${ls.length} O.S (nº ${de} a ${ate})`, colSpan:6 }, oseBRL(total)]], showFoot:"lastPage",
      styles:{ fontSize:9, cellPadding:2, lineColor:[190,190,198], lineWidth:0.2, textColor:[20,20,26], valign:"middle" },
      headStyles:{ fillColor:[214,40,30], textColor:[255,255,255] }, footStyles:{ fillColor:[255,214,0], textColor:[20,20,26], fontStyle:"bold" },
      columnStyles:{ 0:{ fontStyle:"bold", cellWidth:20 }, 3:{ cellWidth:24 }, 4:{ cellWidth:24 }, 5:{ halign:"center", cellWidth:20 }, 6:{ halign:"right", cellWidth:30 } },
      didParseCell:(c)=>{ if(c.column.index===6) c.cell.styles.halign = "right"; if(c.column.index===5 && c.section!=="foot") c.cell.styles.halign = "center"; } });
    let y = doc.lastAutoTable.finalY + 16; if(y > H - 70){ doc.addPage(); y = 30; }
    // assinaturas
    doc.setDrawColor(150, 150, 160); doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(20, 20, 26);
    doc.text("ENTREGUE POR — AVANCE", M, y); doc.text(`RECEBIDO POR — ${(cfg.cliente || "COMBITRANS").toUpperCase()}`, W/2+4, y);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(80, 80, 90);
    [["Nome", 14], ["Assinatura", 28], ["Data / hora", 42]].forEach(([l, dy])=>{
      doc.line(M, y+dy, W/2-6, y+dy); doc.text(l, M, y+dy+4.5); doc.line(W/2+4, y+dy, W-M, y+dy); doc.text(l, W/2+4, y+dy+4.5); });
    doc.text("Carimbo:", W/2+4, y+58); doc.roundedRect(W/2+4, y+61, W/2-4-M, 26, 2, 2);
    const np = doc.internal.getNumberOfPages();
    for(let i = 1; i <= np; i++){ doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(140, 140, 150);
      doc.text(`Protocolo ${nProt} · gerado em ${fmtDataBR(frotaHojeISO())} às ${frotaHora()}${MEU_EMAIL ? " por " + MEU_EMAIL.split("@")[0] : ""}`, M, H-7); doc.text(`Página ${i} de ${np}`, W-M, H-7, { align:"right" }); }
    const url = doc.output("bloburl");
    if(aba){ aba.location.href = url; } else doc.save(`Protocolo_OS_${de}-${ate}.pdf`);
  }catch(e){ if(aba) aba.close(); toast("⚠ Não foi possível gerar o protocolo: " + e.message); }
};
window.oseOSFiltro = (f) => { OSE_OS_FILTRO = OSE_OS_FILTRO===f ? "todas" : f; oseRedesenhar(); };
window.oseAssinada = async (id) => {
  const o = OSE.lista.find(x=>x.id===id); if(!o) return;
  const d = document.getElementById(`ose-ass-${id}`)?.value || frotaHojeISO();
  if(o.emitidaEm && d < o.emitidaEm.slice(0,10)){ toast("A data do retorno está antes da emissão da O.S."); return; }
  if(await oseAtualizarOS(o, { assinada_em:d }, { assinadaEm:d })){ toast(`O.S ${oseNum(o.numero)} assinada pela Combitrans ✓ — agora é emitir a NF`); await oseSincronizarCiclo(o.saida || o.entrada); }
  oseRedesenhar();
};
window.oseDesfazerAssinatura = async (id) => {
  const o = OSE.lista.find(x=>x.id===id); if(!o || !confirm(`Desfazer o retorno assinado da O.S ${oseNum(o.numero)}?`)) return;
  if(await oseAtualizarOS(o, { assinada_em:null }, { assinadaEm:"" })) oseRedesenhar();
};
// Abre o formulário das NF Emitidas já preenchido (Manutenção de Carreta, período da O.S, valor e observação)
window.oseEmitirNF = (id) => {
  const o = OSE.lista.find(x=>x.id===id); if(!o) return;
  NF_ABA = "nfe"; NFE_EDIT = null; NFE_BALSA_ID = null; NFE_OS_ID = id; NFE_ATIV = "manutencao"; NFE_SENTIDO = "";
  NFE_PERIODO = `D:${o.entrada}:${o.saida || o.entrada}`;
  navigate("emissaonf");
  setTimeout(()=>{ nfePreencher({ valor:"R$ " + oseValor(o).toLocaleString("pt-BR", { minimumFractionDigits:2, maximumFractionDigits:2 }), obs:`O.S nº ${oseNum(o.numero)} — frota ${o.frota}${o.placa ? " / " + o.placa : ""}`, data:frotaHojeISO() });
    document.getElementById("nfe-form")?.scrollIntoView({ behavior:"smooth", block:"start" }); }, 80);
};
window.oseCancelarVinculoNF = () => { NFE_OS_ID = null; nfeRedesenhar(); };
async function oseVincularNF(osId, nf){
  const o = OSE.lista.find(x=>x.id===osId); if(!o) return;
  const ok = await oseAtualizarOS(o, { nf_id:nf.id && !String(nf.id).startsWith("tmp") ? nf.id : null, nf_numero:nf.nf, nf_em:nf.dataEmissao||frotaHojeISO(), ...(o.assinadaEm ? {} : { assinada_em:nf.dataEmissao||frotaHojeISO() }) },
    { nfId:nf.id, nfNumero:nf.nf, nfEm:nf.dataEmissao||frotaHojeISO(), assinadaEm:o.assinadaEm || nf.dataEmissao || frotaHojeISO() });
  if(ok) toast(`NF ${nf.nf} ligada à O.S ${oseNum(o.numero)} ✓`);
}
// NF já emitida antes: informa o número (liga à NF das NF Emitidas quando encontrar)
window.oseInformarNF = async (id) => {
  const o = OSE.lista.find(x=>x.id===id); if(!o) return;
  if(MEU_PAPEL !== "administrativo" && !NFE.carregado && !NFE.carregando) await nfeCarregar();
  const num = (prompt(`Nº da NF emitida para a O.S ${oseNum(o.numero)}:`) || "").trim().replace(/^\/|\/$/g,""); if(!num) return;
  const nf = NFE.lista.find(r=>r.nf===num || String(r.nf).split("/").includes(num));
  if(!nf && !confirm(`A NF ${num} não está nas NF Emitidas. Registrar só o número na O.S?`)) return;
  await oseVincularNF(id, nf || { id:null, nf:num, dataEmissao:frotaHojeISO() }); oseRedesenhar();
};
window.oseDesvincularNF = async (id) => {
  const o = OSE.lista.find(x=>x.id===id); if(!o || !confirm(`Tirar a NF ${o.nfNumero} da O.S ${oseNum(o.numero)}? (a NF continua nas NF Emitidas)`)) return;
  if(await oseAtualizarOS(o, { nf_id:null, nf_numero:null, nf_em:null }, { nfId:null, nfNumero:"", nfEm:"" })) oseRedesenhar();
};
function oseSituacaoHTML(o){
  const st = oseSituacao(o), hoje = frotaHojeISO();
  const base = `<span class="badge ${st.badge}">${st.icone} ${st.label}</span>`;
  if(st.k==="aguardando") return `${base}<div class="hint" style="margin:2px 0 4px;">${st.lim ? `limite ${fmtDataBR(st.lim)}` : ""}</div>
    <span style="white-space:nowrap;"><input type="date" id="ose-ass-${o.id}" value="${hoje}" class="nfe-pg"> <button class="os-btn sm" onclick="oseAssinada('${o.id}')">✍️ Retorno assinado</button></span>`;
  if(st.k==="assinada") return `${base}<div class="hint" style="margin:2px 0 4px;">assinada em ${fmtDataBR(o.assinadaEm)} <button class="os-link" onclick="oseDesfazerAssinatura('${o.id}')">desfazer</button></div>
    <span style="white-space:nowrap;">${MEU_PAPEL === "administrativo" ? `<button class="os-btn sm green" onclick="oseInformarNF('${o.id}')">🧾 Informar nº da NF</button>`
      : `<button class="os-btn sm green" onclick="oseEmitirNF('${o.id}')">🧾 Emitir NF</button> <button class="os-link" onclick="oseInformarNF('${o.id}')">já emiti — informar nº</button>`}</span>`;
  return `${base}<div class="hint" style="margin:2px 0 0;">${o.nfEm ? `em ${fmtDataBR(o.nfEm)} · ` : ""}assinada ${o.assinadaEm ? fmtDataBR(o.assinadaEm) : "—"} <button class="os-link" onclick="oseDesvincularNF('${o.id}')">desfazer</button></div>`;
}

// O ciclo semanal da Combitrans (Painel Gerencial) recebe os números e o valor das O.S emitidas da semana
async function oseSincronizarCiclo(dataRef, removido){
  if(!dataRef || typeof manGravar!=="function") return;
  try{
    if(!MAN.carregado) await manCarregar();
    const sem = nfeSegunda(dataRef), c = MAN.ciclos[sem] || {};
    const da = OSE.lista.filter(o=>o.status==="emitida" && nfeSegunda(o.saida || o.entrada)===sem).sort((a,b)=>(a.numero||0)-(b.numero||0));
    if(!da.length && !(removido && String(c.osNumero||"").split(/,\s*/).includes(oseNum(removido)))) return;
    const primeira = da.map(o=>(o.emitidaEm||"").slice(0,10)).filter(Boolean).sort()[0] || frotaHojeISO();
    const ass = da.length && da.every(o=>o.assinadaEm) ? da.map(o=>o.assinadaEm).sort().pop() : null;
    await manGravar(sem, da.length ? { osNumero:da.map(o=>oseNum(o.numero)).join(", "), osValor:Math.round(sumArr(da.map(oseValor))*100)/100,
      dataOS:c.dataOS || primeira, dataDocumento:c.dataDocumento || primeira, ...(ass && !c.dataAssinatura ? { dataAssinatura:ass } : {}) } : { osNumero:"", osValor:null });
  }catch(e){ console.warn("ciclo Combitrans", e); }
}

function oseEditorHTML(){
  const e = OSE_EDIT; if(!e) return "";
  const adm = osePodeEmitir(), veV = oseVeValores(), ehOS = e.status==="nova" || e.status==="emitida";
  const total = sumArr(OSE_ITENS.map(oseValorItem));
  const dif = OSE_ITENS.filter(it=>{ const s = OSE.servicos.find(x=>x.cod===it.cod); return s && (s.mo!==it.mo || s.mat!==it.mat); }).length;
  const titulo = e.status==="emitida" ? `🧾 O.S ${oseNum(e.numero)} — editar` : e.status==="nova" ? (e.preId ? "🔎 Conferir Pré O.S e gerar a O.S" : "🧾 Nova O.S avulsa")
    : `📝 Pré O.S — plano de ${fmtDataBR(e.dataPlano || e.entrada)}${e.id ? " (editar)" : ""}`;
  return `<div class="panel os-form ose-editor ${ehOS ? "os" : ""}" id="ose-form">
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
      <h3 style="margin:0;">${titulo}</h3><button class="os-btn" onclick="oseCancelar()">Fechar</button>
    </div>
    ${e.status==="nova" && e.preId ? `<div class="os-alerta amber" style="margin-top:8px;">Pré O.S lançada por <b>${osEsc(e.preDe||"operação")}</b>${e.liderPor ? ` e validada pelo líder <b>${osEsc(e.liderPor)}</b>` : ""}. Confira <b>frota, placa, datas, horários, serviços, quantidades e cobrança</b> — os ajustes ficam só na O.S; a Pré O.S continua como a operação lançou.</div>` : ""}
    <div class="nf-grid ose-cab">
      ${adm && ehOS ? `<label>Nº da O.S<input id="ose-numero" type="number" min="1" value="${e.numero||""}"></label>` : ""}
      <label>Frota<input id="ose-frota" list="ose-car" value="${osEsc(e.frota)}" style="text-transform:uppercase;" onchange="oseCampo('frota', this.value)"></label>
      <label>Placa<input id="ose-placa" value="${osEsc(e.placa)}" style="text-transform:uppercase;" onchange="oseCampo('placa', this.value)"></label>
      <label>Início (entrada)<input id="ose-entrada" type="date" value="${e.entrada||""}" onchange="oseCampo('entrada', this.value)"></label>
      <label>Hora<input id="ose-entradaHora" type="time" value="${e.entradaHora||""}" onchange="oseCampo('entradaHora', this.value)"></label>
      <label>Saída<input id="ose-saida" type="date" value="${e.saida||""}" onchange="oseCampo('saida', this.value)"></label>
      <label>Hora<input id="ose-saidaHora" type="time" value="${e.saidaHora||""}" onchange="oseCampo('saidaHora', this.value)"></label>
      ${adm && ehOS ? `<label>Orçamento / referência<input id="ose-referencia" value="${osEsc(e.referencia||"")}" placeholder="opcional" onchange="oseCampo('referencia', this.value)"></label>` : ""}
    </div>
    <datalist id="ose-car">${oseCarretas().map(c=>`<option value="${osEsc(c.frota)}">${osEsc(c.placa)}</option>`).join("")}</datalist>
    <div class="ose-add">
      <label style="flex:1; min-width:240px;">Serviço (código ou nome)<input id="ose-serv" list="ose-servs" placeholder="${OSE.servicos.length ? "ex: 12 ou REBITAMENTO" : "tabela de serviços não importada"}" onkeydown="if(event.key==='Enter') oseAddItem()"></label>
      <label style="width:90px;">Qtd<input id="ose-qtd" inputmode="decimal" value="1" onkeydown="if(event.key==='Enter') oseAddItem()"></label>
      <button class="entry-submit" style="margin:0;" onclick="oseAddItem()">+ Serviço</button>
    </div>
    <datalist id="ose-servs">${OSE.servicos.map(s=>`<option value="${s.cod} — ${osEsc(s.servico)}">`).join("")}</datalist>
    ${OSE_ITENS.length ? `<div style="overflow-x:auto; margin-top:10px;"><table class="nf-tab ose-itens">
      <thead><tr><th>Cód</th><th>Serviço</th><th class="num">Qtd</th><th>Cobrança</th>${veV ? `<th class="num">Mão de obra</th><th class="num">Peças</th><th class="num">Total</th>` : ""}<th></th></tr></thead>
      <tbody>${OSE_ITENS.map((it,i)=>`<tr>
        <td><b>${it.cod}</b></td><td>${osEsc(it.servico)}</td>
        <td class="num"><input class="bal-num" style="width:64px; text-align:right;" value="${String(it.qtd).replace(".", ",")}" inputmode="decimal" onchange="oseQtd(${i}, this.value)"> ${it.un==="m" ? "m" : ""}</td>
        <td>${it.mo && it.mat ? `<select onchange="oseCobrarItem(${i}, this.value)" style="padding:4px 6px; font-size:12px;">${Object.entries(OSE_COBRAR).map(([k,l])=>`<option value="${k}" ${it.cobrar===k?"selected":""}>${l}</option>`).join("")}</select>` : `<span class="hint" style="margin:0;">${it.mat && !it.mo ? "Peças / material" : "Mão de obra"}</span>`}</td>
        ${veV ? `<td class="num">${it.cobrar==="mat" ? "—" : fmtBRL2(it.mo||0)}</td><td class="num">${it.cobrar==="mo" ? "—" : fmtBRL2(it.mat||0)}</td><td class="num"><b>${fmtBRL2(oseValorItem(it))}</b></td>` : ""}
        <td><button class="os-link" onclick="oseRemover(${i})" title="Remover">🗑️</button></td></tr>`).join("")}</tbody>
      ${veV ? `<tfoot><tr style="font-weight:800; background:var(--paper);"><td colspan="6">${ehOS ? "Valor para emissão de NF" : "Valor estimado"}</td><td class="num">${fmtBRL2(total)}</td><td></td></tr></tfoot>` : ""}
    </table></div>` : `<div class="empty-state" style="padding:14px;"><p>Nenhum serviço lançado ainda.</p></div>`}
    ${adm && dif ? `<div class="hint" style="margin-top:6px; color:var(--amber);">⚠ ${dif} serviço(s) com preço diferente da tabela atual. <button class="os-link" onclick="oseAtualizarPrecos()">usar preços da tabela</button></div>` : ""}
    <label>Observação<input id="ose-obs" value="${osEsc(e.obs||"")}" placeholder="opcional" onchange="oseCampo('obs', this.value)"></label>
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px;">
      ${e.status==="nova" ? `<button class="entry-submit" style="margin:0; background:var(--green);" onclick="oseSalvar(true)">✅ ${e.preId ? "Validar e gerar a O.S" : "Emitir O.S"}</button>`
        : `<button class="entry-submit" style="margin:0;" onclick="oseSalvar(false)">${e.status==="emitida" ? "💾 Salvar alterações da O.S" : e.id ? "💾 Salvar Pré O.S" : "💾 Lançar no plano do dia"}</button>`}
    </div>
  </div>`;
}

// Célula da Pré O.S em cada carreta do Controle diário
function osePreCelula(c){
  const o = osePorFila(c.id);
  if(!o) return `<button class="os-link ose-pre-btn" onclick="osePreAbrir('${c.id}')">📝 Pré O.S</button>`;
  if(o.status==="emitida") return `<span class="badge green">🧾 O.S ${oseNum(o.numero)}</span>`;
  if(o.status==="validada"){ const os = oseDaPre(o.id); return `<span class="badge green" title="A administração gerou a O.S">✅ O.S ${os ? oseNum(os.numero) : "gerada"}</span>`; }
  if(o.status==="pre") return `<span class="badge amber" title="Validada pelo líder — com a administração">📤 com a administração</span>`;
  return `<button class="os-link" onclick="osePreAbrir('${c.id}')" title="Editar a Pré O.S"><span class="badge gray">📝 em lançamento · ${o.itens.length} serv.</span></button>`;
}

/* ---------- Plano do dia (operação lança as Pré O.S; o líder valida no fim do dia) ---------- */
window.oseSetPlanoDia = (d) => { if(d){ OSE_PLANO_DIA = d; oseRedesenhar(); } };
// Plano do dia em PDF: abre numa aba nova para visualizar e imprimir (a oficina não vê valores)
// Pré O.S completas em PDF (todas as informações de cada uma): lista da conferência ou uma só
window.osePreImprimir = async (id) => {
  const veV = oseVeValores();
  const ls = id ? OSE.lista.filter(o=>o.id===id)
    : OSE.lista.filter(o=>o.status===(OSE_FILTRO==="validada" ? "validada" : "pre")).sort((a,b)=>oseDiaPlano(a).localeCompare(oseDiaPlano(b)) || (a.frota||"").localeCompare(b.frota||"", undefined, { numeric:true }));
  if(!ls.length){ toast("Nenhuma Pré O.S para imprimir."); return; }
  const aba = window.open("", "_blank");
  try{
    await nfgCarregarPDF();
    const { jsPDF } = window.jspdf, doc = new jsPDF({ unit:"mm", format:"a4" }), W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 12;
    const hm = (iso) => iso ? `${fmtDataBR(iso.slice(0,10))} ${frotaHora(iso)}` : "—";
    const br = (iso, hora) => iso ? `${fmtDataBR(iso)}${hora ? ` às ${hora}` : ""}` : "—";
    doc.setFillColor(214, 40, 30); doc.rect(0, 0, W, 4, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.setTextColor(20, 20, 26); doc.text("AVANCE LOGÍSTICA INTEGRADA", M, 15);
    doc.setFontSize(12); doc.setTextColor(214, 40, 30);
    doc.text(id ? "Pré O.S — manutenção de carreta" : (OSE_FILTRO==="validada" ? "Pré O.S que viraram O.S" : "Pré O.S validadas pelo líder — para conferência da administração"), M, 22);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(90, 90, 100);
    doc.text(`${ls.length} Pré O.S · ${sumArr(ls.map(o=>o.itens.length))} serviço(s)${veV ? ` · valor estimado ${oseBRL(sumArr(ls.map(oseValor)))}` : ""} · gerado em ${fmtDataBR(frotaHojeISO())} às ${frotaHora()}`, M, 28);
    let y = 33;
    ls.forEach((o, n)=>{
      const os = oseDaPre(o.id), st = OSE_ST[o.status] || { label:o.status };
      if(y > H - 60){ doc.addPage(); y = 16; }
      // faixa da Pré O.S
      doc.setFillColor(20, 20, 26); doc.rect(M, y, W-2*M, 8, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.setTextColor(255, 255, 255);
      doc.text(`${n+1}. Frota ${o.frota||"-"}${o.placa ? "  ·  Placa " + o.placa : ""}`, M+3, y+5.5);
      doc.setFontSize(8.5); doc.text(`${st.label}${o.status==="validada" && os ? ` · O.S ${oseNum(os.numero)}` : ""}`, W-M-3, y+5.5, { align:"right" });
      y += 8;
      // informações
      const info = [["Plano de", oseDiaPlano(o) ? fmtDataBR(oseDiaPlano(o)) : "—"], ["Início (entrada)", br(o.entrada, o.entradaHora)], ["Saída", br(o.saida, o.saidaHora)],
        ["Lançada por", o.por || "—"], ["Validada pelo líder", o.liderPor ? `${o.liderPor} · ${hm(o.liderEm)}` : "—"], ["Carreta da fila do pátio", o.filaId ? "sim" : "não (lançada direto no plano)"]];
      doc.autoTable({ startY:y, margin:{ left:M, right:M }, theme:"grid", body:[info.slice(0,3).flat(), info.slice(3).flat()],
        styles:{ fontSize:8, cellPadding:1.5, lineColor:[200,200,206], lineWidth:0.2, textColor:[20,20,26] },
        columnStyles:{ 0:{ fontStyle:"bold", fillColor:[245,245,247], cellWidth:28 }, 2:{ fontStyle:"bold", fillColor:[245,245,247], cellWidth:30 }, 4:{ fontStyle:"bold", fillColor:[245,245,247], cellWidth:34 } } });
      y = doc.lastAutoTable.finalY;
      // serviços
      const head = ["Cód", "Serviço", "Qtd", "Cobrança", ...(veV ? ["Mão de obra", "Peças", "Total"] : [])];
      doc.autoTable({ startY:y, margin:{ left:M, right:M }, theme:"striped", head:[head],
        body:(o.itens.length ? o.itens : []).map(it=>[String(it.cod), it.servico, `${String(it.qtd).replace(".", ",")}${it.un==="m" ? " m" : ""}`, OSE_COBRAR[it.cobrar] || OSE_COBRAR.ambos,
          ...(veV ? [it.cobrar==="mat" ? "-" : oseBRL(it.mo), it.cobrar==="mo" ? "-" : oseBRL(it.mat), oseBRL(oseValorItem(it))] : [])]),
        ...(veV ? { foot:[[{ content:"Valor estimado da Pré O.S", colSpan:6 }, oseBRL(oseValor(o))]] } : {}),
        styles:{ fontSize:8, cellPadding:1.5, valign:"middle", textColor:[20,20,26] }, headStyles:{ fillColor:[214,40,30], textColor:[255,255,255] }, footStyles:{ fillColor:[245,245,247], textColor:[20,20,26], fontStyle:"bold" },
        columnStyles:{ 0:{ cellWidth:12, fontStyle:"bold" }, 2:{ cellWidth:15, halign:"center" }, 3:{ cellWidth:28 }, ...(veV ? { 4:{ cellWidth:24, halign:"right" }, 5:{ cellWidth:22, halign:"right" }, 6:{ cellWidth:24, halign:"right" } } : {}) },
        didParseCell:(c)=>{ if(veV && c.column.index>=4) c.cell.styles.halign = "right"; } });
      y = doc.lastAutoTable.finalY;
      if(o.obs){ doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(20, 20, 26); doc.text("Observação:", M, y+5);
        doc.setFont("helvetica", "normal"); const l = doc.splitTextToSize(o.obs, W-2*M-22); doc.text(l, M+20, y+5); y += 3 + l.length*4; }
      y += 9;
    });
    if(!id && veV){ if(y > H - 25){ doc.addPage(); y = 20; }
      doc.setFillColor(255, 214, 0); doc.rect(M, y, W-2*M, 8, "F"); doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(20, 20, 26);
      doc.text(`Total estimado (${ls.length} Pré O.S)`, M+3, y+5.5); doc.text(oseBRL(sumArr(ls.map(oseValor))), W-M-3, y+5.5, { align:"right" }); }
    const np = doc.internal.getNumberOfPages();
    for(let i = 1; i <= np; i++){ doc.setPage(i); doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(140, 140, 150); doc.text("Avance Logística Integrada · Pré O.S", M, H-6); doc.text(`Página ${i} de ${np}`, W-M, H-6, { align:"right" }); }
    const url = doc.output("bloburl");
    if(aba){ aba.location.href = url; } else doc.save(id ? `Pre_OS_frota_${ls[0].frota}.pdf` : "Pre_OS_conferencia.pdf");
  }catch(e){ if(aba) aba.close(); toast("⚠ Não foi possível gerar o PDF: " + e.message); }
};
window.osePlanoImprimir = async () => {
  const d = OSE_PLANO_DIA, veV = oseVeValores();
  const ls = OSE.lista.filter(o=>oseEhPre(o) && oseDiaPlano(o)===d).sort((a,b)=>(a.frota||"").localeCompare(b.frota||"", undefined, { numeric:true }));
  if(!ls.length){ toast(`Nenhuma Pré O.S no plano de ${fmtDataBR(d)}.`); return; }
  const aba = window.open("", "_blank");   // abre já no clique (o navegador não bloqueia)
  try{
    await nfgCarregarPDF();
    const { jsPDF } = window.jspdf, doc = new jsPDF({ unit:"mm", format:"a4", orientation:"landscape" }), W = doc.internal.pageSize.getWidth(), M = 12;
    doc.setFillColor(214, 40, 30); doc.rect(0, 0, W, 4, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.setTextColor(20, 20, 26); doc.text("AVANCE LOGÍSTICA INTEGRADA", M, 15);
    doc.setFontSize(12); doc.setTextColor(214, 40, 30); doc.text(`Plano do dia — Pré O.S de manutenção de carretas`, M, 22);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(90, 90, 100);
    doc.text(`${progDiaSemana(d)}, ${fmtDataBR(d)}  ·  ${ls.length} carreta(s)  ·  ${sumArr(ls.map(o=>o.itens.length))} serviço(s)`, M, 28);
    doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(20, 20, 26);
    doc.text(`Em lançamento: ${ls.filter(o=>o.status==="plano").length}   ·   Validadas pelo líder: ${ls.filter(o=>o.status==="pre").length}   ·   Viraram O.S: ${ls.filter(o=>o.status==="validada").length}`, W-M, 28, { align:"right" });
    const body = [];
    ls.forEach(o=>{ const st = OSE_ST[o.status], os = oseDaPre(o.id), n = Math.max(1, o.itens.length);
      const sit = `${st.label}${o.status==="validada" && os ? ` · O.S ${oseNum(os.numero)}` : ""}${o.liderPor ? `\npor ${o.liderPor}` : ""}`;
      (o.itens.length ? o.itens : [null]).forEach((it, i)=>{
        const linha = [];
        if(i===0) linha.push({ content:o.frota||"-", rowSpan:n, styles:{ fontStyle:"bold", fontSize:10 } }, { content:o.placa||"-", rowSpan:n });
        linha.push(it ? String(it.cod) : "-", it ? it.servico : "(sem serviços)", it ? `${String(it.qtd).replace(".", ",")}${it.un==="m" ? " m" : ""}` : "");
        if(veV) linha.push(it ? oseBRL(oseValorItem(it)) : "");
        if(i===0) linha.push({ content:sit, rowSpan:n }, { content:o.por||"-", rowSpan:n }, { content:"", rowSpan:n });
        body.push(linha); });
    });
    const head = ["Frota", "Placa", "Cód", "Serviço planejado", "Qtd", ...(veV ? ["Valor est."] : []), "Situação", "Lançado por", "Feito"];
    const ci = (k) => head.indexOf(k);
    doc.autoTable({ startY:33, margin:{ left:M, right:M }, theme:"grid", head:[head], body,
      ...(veV ? { foot:[[{ content:"Valor estimado do plano", colSpan:5 }, oseBRL(sumArr(ls.map(oseValor))), { content:"", colSpan:3 }]], showFoot:"lastPage" } : {}),
      styles:{ fontSize:8.5, cellPadding:1.8, valign:"middle", lineColor:[180,180,188], lineWidth:0.2, textColor:[20,20,26] },
      headStyles:{ fillColor:[20,20,26], textColor:[255,255,255] }, footStyles:{ fillColor:[245,245,247], textColor:[20,20,26], fontStyle:"bold" },
      columnStyles:{ [ci("Frota")]:{ cellWidth:20 }, [ci("Placa")]:{ cellWidth:24 }, [ci("Cód")]:{ cellWidth:13, halign:"center" }, [ci("Qtd")]:{ cellWidth:15, halign:"center" },
        ...(veV ? { [ci("Valor est.")]:{ cellWidth:24, halign:"right" } } : {}), [ci("Situação")]:{ cellWidth:40 }, [ci("Lançado por")]:{ cellWidth:26 }, [ci("Feito")]:{ cellWidth:18 } },
      didParseCell:(c)=>{ if(veV && c.column.index===ci("Valor est.")) c.cell.styles.halign = "right"; } });
    let y = doc.lastAutoTable.finalY + 14; if(y > 185){ doc.addPage(); y = 30; }
    doc.setDrawColor(150, 150, 160); doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(80, 80, 90);
    doc.line(M, y, M+85, y); doc.text("Líder da operação — validação do plano", M, y+4.5);
    doc.line(W-M-85, y, W-M, y); doc.text("Data / hora: ____/____/________  ____:____", W-M-85, y+4.5);
    const np = doc.internal.getNumberOfPages();
    for(let i = 1; i <= np; i++){ doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(140, 140, 150); doc.text(`Gerado em ${fmtDataBR(frotaHojeISO())} às ${frotaHora()}`, M, 203); doc.text(`Página ${i} de ${np}`, W-M, 203, { align:"right" }); }
    const url = doc.output("bloburl");
    if(aba){ aba.location.href = url; } else doc.save(`Plano_do_dia_${d}.pdf`);
  }catch(e){ if(aba) aba.close(); toast("⚠ Não foi possível gerar o plano: " + e.message); }
};
window.oseMoverPlanoDia = (n) => oseSetPlanoDia(nfeAddDias(OSE_PLANO_DIA, n));
function osePlanoHTML(diaFixo){
  if(diaFixo) OSE_PLANO_DIA = diaFixo;
  if(OSE.erro) return `<div class="os-alerta amber" style="margin-bottom:16px;">⚠️ Pré O.S indisponível: ${osEsc(OSE.erro)}. Rode o SQL da Emissão de O.S no Supabase.</div>`;
  const d = OSE_PLANO_DIA, hoje = d===frotaHojeISO(), veV = oseVeValores();
  const doDia = OSE.lista.filter(o=>oseEhPre(o) && oseDiaPlano(o)===d).sort((a,b)=>(a.frota||"").localeCompare(b.frota||"", undefined, { numeric:true }));
  const emLanc = doDia.filter(o=>o.status==="plano"), enviadas = doDia.filter(o=>o.status!=="plano");
  const resumoItens = (o) => (o.itens||[]).map(it=>`<span class="ose-chip" title="${osEsc(it.servico)}"><b>${it.cod}</b> ${String(it.qtd).replace(".", ",")}${it.un==="m" ? "m" : ""}</span>`).join("");
  return `<div class="panel ose-bloco plano" style="margin-bottom:16px;">
    <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
      <div><h3 style="margin:0;">📝 Plano do dia — Pré O.S da operação</h3>
        <div class="hint">A operação lança o que será feito em cada carreta; no fim do dia o <b>líder valida</b> e as Pré O.S vão para a administração.</div></div>
      ${diaFixo ? `<b>${fmtDataBR(d)}</b>` : `<div class="prog-dia">
        <button class="os-btn" onclick="oseMoverPlanoDia(-1)">◀</button><input type="date" value="${d}" onchange="oseSetPlanoDia(this.value)"><button class="os-btn" onclick="oseMoverPlanoDia(1)">▶</button>
        ${hoje ? `<span class="badge green">hoje</span>` : `<button class="os-link" onclick="oseSetPlanoDia('${frotaHojeISO()}')">hoje</button>`}
      </div>`}
    </div>
    <div class="ose-plano-topo">
      <span class="ose-pill gray">📝 Em lançamento <b>${emLanc.length}</b></span>
      <span class="ose-pill amber">📤 Validadas pelo líder <b>${doDia.filter(o=>o.status==="pre").length}</b></span>
      <span class="ose-pill green">✅ Viraram O.S <b>${doDia.filter(o=>o.status==="validada").length}</b></span>
      <span style="flex:1;"></span>
      ${doDia.length ? `<button class="os-btn" onclick="osePlanoImprimir()" title="Abre o plano do dia em PDF para visualizar e imprimir">🖨️ Visualizar / imprimir plano</button>` : ""}
      <button class="os-btn" onclick="oseNovaPre()">+ Lançar Pré O.S</button>
      ${emLanc.length ? `<span class="hint" style="margin:0;">Líder: valide cada Pré O.S na linha (✅ Validar)</span>` : ""}
    </div>
    ${doDia.length ? `<div style="overflow-x:auto; margin-top:10px;"><table class="nf-tab">
      <thead><tr><th>Frota · Placa</th><th>Serviços planejados</th>${veV ? `<th class="num">Valor estimado</th>` : ""}<th>Situação</th><th>Lançado por</th><th></th></tr></thead>
      <tbody>${doDia.map(o=>{ const s = OSE_ST[o.status], os = oseDaPre(o.id); return `<tr>
        <td><b>${osEsc(o.frota)}</b>${o.placa ? ` · ${osEsc(o.placa)}` : ""}</td>
        <td class="ose-chips">${resumoItens(o) || "—"}</td>${veV ? `<td class="num">${fmtBRL2(oseValor(o))}</td>` : ""}
        <td><span class="badge ${s.badge}">${s.icone} ${s.label}${o.status==="validada" && os ? ` · O.S ${oseNum(os.numero)}` : ""}</span>${o.liderPor ? `<div class="hint" style="margin:0;">validada por ${osEsc(o.liderPor)}${o.liderEm ? ` · ${frotaHora(o.liderEm)}` : ""}</div>` : ""}</td>
        <td style="font-size:12px;">${osEsc(o.por||"")}</td>
        <td style="white-space:nowrap;">${o.status==="plano" ? `<button class="os-btn sm green" onclick="oseLiderValidar('${o.id}')" title="Líder: validar esta Pré O.S e enviar para a administração">✅ Validar</button> <button class="os-link" onclick="oseEditarPre('${o.id}')" title="Editar">✏️</button> <button class="os-link" onclick="oseExcluir('${o.id}')" title="Excluir">🗑️</button>` : ""}</td>
      </tr>`; }).join("")}</tbody></table></div>`
      : `<div class="empty-state" style="padding:16px;"><p>Nenhuma Pré O.S lançada para ${fmtDataBR(d)}. Clique em <b>+ Lançar Pré O.S</b>${diaFixo ? " ou em <b>📝 Pré O.S</b> na carreta da fila" : ""}.</p></div>`}
    ${enviadas.length && !emLanc.length ? `<div class="hint" style="margin-top:8px;">✓ Todas as Pré O.S de ${fmtDataBR(d)} foram validadas pelo líder e estão com a administração.</div>` : ""}
  </div>`;
}

/* ---------- PDF da O.S — modelo da Avance para a Combitrans ---------- */
// Cabeçalho do modelo da O.S (logo AVANCE + dados da Avance + dados do cliente) — O.S e protocolo de entrega
function oseCabecalhoPDF(doc, M){
  const W = doc.internal.pageSize.getWidth(), cfg = oseCfg();
  // logotipo: seta vermelha + AVANCE
  doc.setDrawColor(40, 40, 46); doc.setLineWidth(0.4); doc.rect(M, 10, 112, 26);
  doc.setFillColor(214, 40, 30); doc.triangle(M+6, 15, M+19, 23, M+6, 31, "F"); doc.setFillColor(255, 255, 255); doc.triangle(M+6, 18, M+12, 23, M+6, 28, "F");
  doc.setFillColor(232, 80, 40); doc.triangle(M+4, 14, M+10, 17, M+5, 19, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(30); doc.setTextColor(40, 40, 50); doc.text("A V A N C E", M+24, 28);
  // dados da empresa
  doc.rect(M+114, 10, W-2*M-114, 26);
  doc.setFontSize(7); doc.setTextColor(20, 20, 26);
  [["EMPRESA", cfg.empresa], ["RAZÃO SOCIAL", cfg.razao], ["CNPJ", cfg.cnpj], ["ENDEREÇO", cfg.endereco], ["CEP", cfg.cep]].forEach(([l, v], i)=>{
    doc.setFont("helvetica", "bold"); doc.text(`${l}:`, M+116, 15 + i*4.6); const lw = doc.getTextWidth(`${l}: `) + 0.8;
    doc.setFont("helvetica", "normal"); doc.text(doc.splitTextToSize(String(v||""), W-2*M-118-lw)[0] || "", M+116+lw, 15 + i*4.6); });
  // cliente (esquerda) e quadro da O.S (direita)
  doc.setFontSize(8.5); doc.setTextColor(20, 20, 26);
  [["Cliente", cfg.cliente], ["Endereço", cfg.clienteEndereco], ["CNPJ", cfg.clienteCnpj]].forEach(([l, v], i)=>{ doc.setFont("helvetica", "bold"); doc.text(`${l}:`, M, 47 + i*5); const lw = doc.getTextWidth(`${l}: `) + 0.8; doc.setFont("helvetica", "normal"); doc.text(String(v||""), M + lw, 47 + i*5); });
}
async function osePDFDoc(o){
  await nfgCarregarPDF();
  const { jsPDF } = window.jspdf, doc = new jsPDF({ unit:"mm", format:"a4" }), W = doc.internal.pageSize.getWidth(), cfg = oseCfg();
  const total = oseValor(o), M = 12;
  const br = (iso) => iso ? `${iso.slice(8,10)}-${iso.slice(5,7)}-${iso.slice(0,4)}` : "";
  oseCabecalhoPDF(doc, M);
  const X = M+108, QW = W-M-X;
  doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.text(`ORDEM DE SERVIÇO Nº ${oseNum(o.numero)}`, X + QW/2, 41.5, { align:"center" });
  doc.setFillColor(235, 235, 238); doc.rect(X, 43.5, QW, 5, "F"); doc.setFont("helvetica", "normal"); doc.setFontSize(8);
  doc.text(o.referencia ? `Orçamento ${o.referencia}` : "Orçamento —", X + QW/2, 47, { align:"center" });
  doc.rect(X, 48.5, QW, 10); doc.line(X, 53.5, X+QW, 53.5); doc.line(X+QW*0.62, 48.5, X+QW*0.62, 58.5);
  doc.text(`Início: ${br(o.entrada)}${o.entradaHora ? ` / Hora: ${o.entradaHora}` : ""}`, X+2, 52); doc.text(`Placa: ${o.placa||""}`, X+QW*0.62+2, 52);
  doc.text(`Saída: ${br(o.saida)}${o.saidaHora ? ` / Hora: ${o.saidaHora}` : ""}`, X+2, 57); doc.text(`Frota: ${o.frota||""}`, X+QW*0.62+2, 57);
  doc.setFillColor(255, 214, 0); doc.rect(X, 58.5, QW, 6, "FD"); doc.setFont("helvetica", "bold"); doc.setFontSize(8.5);
  doc.text("VALOR PARA EMISSÃO DE NF.", X+2, 62.7); doc.text(oseBRL(total), X+QW-2, 62.7, { align:"right" });
  // serviços
  doc.autoTable({ startY:66, margin:{ left:M, right:M }, theme:"grid",
    head:[["SERVIÇO", "CÓD", "Qntd", "MÃO DE OBRA", "Qntd", "PEÇAS", "Valor Total"]],
    body:(o.itens||[]).map(it=>{ const q = `${String(it.qtd).replace(".", ",")}${it.un==="m" ? " m" : ""}`, temMo = it.cobrar!=="mat" && it.mo, temMat = it.cobrar!=="mo" && it.mat;
      return [it.servico, String(it.cod), temMo ? q : "", temMo ? oseBRL(it.mo) : "", temMat ? q : "", temMat ? oseBRL(it.mat) : "", oseBRL(oseValorItem(it))]; }),
    foot:[[{ content:"", colSpan:6, styles:{ fillColor:[235,235,238] } }, { content:oseBRL(total), styles:{ fillColor:[255,214,0], textColor:[20,20,26], fontStyle:"bold", halign:"right" } }]], showFoot:"lastPage",
    styles:{ fontSize:8, cellPadding:1.6, lineColor:[60,60,66], lineWidth:0.2, textColor:[20,20,26], valign:"middle" },
    headStyles:{ fillColor:[214,40,30], textColor:[255,255,255], fontStyle:"bold", halign:"center" }, footStyles:{ fillColor:[235,235,238] },
    columnStyles:{ 0:{ cellWidth:"auto" }, 1:{ halign:"center", cellWidth:12 }, 2:{ halign:"center", cellWidth:13 }, 3:{ halign:"right", cellWidth:25 }, 4:{ halign:"center", cellWidth:13 }, 5:{ halign:"right", cellWidth:22 }, 6:{ halign:"right", cellWidth:26 } } });
  let y = doc.lastAutoTable.finalY + 10;
  if(o.obs){ doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.text("Observação:", M, y); doc.setFont("helvetica", "normal"); const l = doc.splitTextToSize(o.obs, W-2*M-22); doc.text(l, M+20, y); y += 6 + l.length*4; }
  doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.text("CARIMBOS :", M, y + 6);
  y = Math.max(y + 40, 250);
  doc.setDrawColor(150, 150, 160); doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(80, 80, 90);
  doc.line(M, y, M+80, y); doc.text("Avance Logística Integrada", M, y+4.5); if(o.emitidaPor) doc.text(`Emitida por: ${o.emitidaPor}`, M, y+9);
  doc.line(W-M-80, y, W-M, y); doc.text(`${cfg.cliente || "Cliente"} — análise e assinatura`, W-M-80, y+4.5); doc.text("Data: ____/____/________", W-M-80, y+9);
  return doc;
}
const oseNomePDF = (o) => `OS_${oseNum(o.numero)}_frota_${String(o.frota).replace(/[^A-Z0-9]+/gi,"")}.pdf`;
function oseConfereCfg(){ return OSE.cfgSalvo || confirm("Os dados do cabeçalho da O.S (CNPJ, endereço da Avance e do cliente) ainda não foram conferidos e salvos.\n\nGerar o PDF assim mesmo?"); }
window.osePDF = async (id) => { const o = OSE.lista.find(x=>x.id===id); if(!o || !oseConfereCfg()) return; try{ (await osePDFDoc(o)).save(oseNomePDF(o)); }catch(e){ toast("⚠ Não foi possível gerar o PDF: " + e.message); } };
window.oseEnviar = async (id) => {
  const o = OSE.lista.find(x=>x.id===id); if(!o || !oseConfereCfg()) return;
  let doc; try{ doc = await osePDFDoc(o); }catch(e){ toast("⚠ Não foi possível gerar o PDF: " + e.message); return; }
  const nome = oseNomePDF(o), texto = `*Avance Logística Integrada*\nO.S nº ${oseNum(o.numero)} — frota ${o.frota}${o.placa ? " / " + o.placa : ""}\nValor para emissão de NF: *${oseBRL(oseValor(o))}*\nSegue a O.S para análise e assinatura.`;
  const arq = new File([doc.output("blob")], nome, { type:"application/pdf" });
  if(navigator.canShare && navigator.canShare({ files:[arq] })){
    try{ await navigator.share({ files:[arq], title:`O.S ${oseNum(o.numero)}`, text:texto.replace(/\*/g,"") }); return; } catch(e){ if(e.name === "AbortError") return; }
  }
  doc.save(nome); window.open("https://wa.me/?text=" + encodeURIComponent(texto), "_blank"); toast("PDF baixado — no WhatsApp, anexe o arquivo " + nome);
};
// Dados do cabeçalho (Avance e cliente) — salvos no banco
window.oseSalvarCfg = async () => {
  const novo = {}; Object.keys(OSE_CFG_PADRAO).forEach(k=>{ novo[k] = (document.getElementById(`ose-cfg-${k}`)?.value || "").trim(); });
  if(sb){ const { error } = await sb.from("app_config").upsert({ chave:"os_cabecalho", valor:novo, atualizado_por:MEU_EMAIL, atualizado_em:new Date().toISOString() }, { onConflict:"chave" });
    if(error){ toast(/app_config/i.test(error.message) ? "⚠ Falta rodar o SQL da Emissão de O.S no Supabase." : "⚠ Não salvou: " + error.message); return; } }
  OSE.cfg = novo; OSE.cfgSalvo = true; oseSalvarLocal(); toast("Dados do cabeçalho da O.S salvos ✓"); oseRedesenhar();
};

/* ---------- Importar a tabela de serviços (planilha "TABELA DE SERVIÇO 2026 - CARRETA") ---------- */
window.oseImportarTabela = async () => {
  const file = document.getElementById("ose-tab-file")?.files[0], st = document.getElementById("ose-tab-st");
  if(!file){ st.textContent = "⚠ Escolha o arquivo primeiro."; return; }
  st.textContent = "Lendo planilha...";
  try{
    const wb = XLSX.read(await file.arrayBuffer(), { type:"array" }), servicos = [];
    wb.SheetNames.forEach(nome=>{
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header:1, defval:null });
      if(rows.slice(0,6).some(r=>r && r.some(c=>String(c||"").trim().toUpperCase()==="PLACA"))) return;   // aba de placas
      let grupo = null;
      rows.forEach(r=>{ if(!r) return; const a = r[0], c = r[2];
        if(typeof a === "string" && a.trim() && (c==null || c==="") && !/^TABELA/i.test(a.trim())){ grupo = a.trim(); return; }
        if(typeof a === "number" && c){ const num = (v)=> typeof v === "number" ? v : null; servicos.push({ cod:a, servico:String(c).replace(/\s+/g," ").trim(), grupo, mo:num(r[3]), mat:num(r[4]) }); } });
    });
    const vistos = new Set(), unicos = servicos.filter(s=>vistos.has(s.cod) ? false : vistos.add(s.cod));
    if(!unicos.length){ st.textContent = "⚠ Não encontrei a tabela de serviços (colunas CÓD / SERVIÇOS / M.OBRA / MATERIAL)."; return; }
    if(sb){ st.textContent = `Gravando ${unicos.length} serviços no banco...`; await sbSubstituirTabela("os_servicos", unicos); }
    OSE.servicos = unicos.sort((a,b)=>a.cod-b.cod); oseSalvarLocal();
    st.innerHTML = `✓ <b>${unicos.length}</b> serviços importados.`; toast("Tabela de serviços importada ✓"); setTimeout(()=>oseRedesenhar(), 700);
  }catch(e){ st.innerHTML = "⚠ " + (e.message||e); }
};

/* ---------- Tela: Emissão de NF › Emissão de O.S ---------- */
window.oseFiltro = (f) => { OSE_FILTRO = f; oseRedesenhar(); };
function osePagina(){
  oseGarantirCarga();
  if(OSE.erro) return `<div class="panel"><div class="empty-state" style="padding:24px;"><div class="glyph">⚠️</div><h4>Não foi possível carregar as O.S</h4><p>${osEsc(OSE.erro)}</p><p>Se falar em tabela ou coluna inexistente ("manutencao_os", "status"), rode o SQL da Emissão de O.S no Supabase.</p></div></div>`;
  if(!OSE.carregado) return `<div class="panel"><div class="empty-state" style="padding:24px;"><p>Carregando...</p></div></div>`;
  const mes = frotaHojeISO().slice(0,7), cfg = oseCfg();
  const emLanc = OSE.lista.filter(o=>o.status==="plano"), pre = OSE.lista.filter(o=>o.status==="pre"), validadas = OSE.lista.filter(o=>o.status==="validada"), emit = OSE.lista.filter(o=>o.status==="emitida");
  const emitMes = emit.filter(o=>(o.emitidaEm||o.entrada||"").startsWith(mes));
  if(!["pre","validada"].includes(OSE_FILTRO)) OSE_FILTRO = "pre";
  const listaPre = (OSE_FILTRO==="pre" ? pre : validadas).sort((a,b)=>oseDiaPlano(a).localeCompare(oseDiaPlano(b)));
  const contSit = { aguardando:0, assinada:0, nf:0 }; emit.forEach(o=>contSit[oseSituacao(o).k]++);
  const listaOS = emit.filter(o=>OSE_OS_FILTRO==="todas" || oseSituacao(o).k===OSE_OS_FILTRO).sort((a,b)=>(b.numero||0)-(a.numero||0) || (b.entrada||"").localeCompare(a.entrada||""));
  const resumoItens = (o) => (o.itens||[]).map(it=>`<span class="ose-chip" title="${osEsc(it.servico)}"><b>${it.cod}</b> ${String(it.qtd).replace(".", ",")}${it.un==="m" ? "m" : ""}</span>`).join("");
  const destaque = (o) => OSE_EDIT && (OSE_EDIT.id===o.id || OSE_EDIT.preId===o.id) ? 'style="background:#FCF1DE;"' : "";
  return `
    <div class="ose-fluxo">
      <div><span>1</span><b>Plano do dia</b><small>operação lança a Pré O.S</small><em>${emLanc.length} em lançamento</em></div>
      <div><span>2</span><b>Líder valida</b><small>no fim do dia</small><em>${pre.length} com a administração</em></div>
      <div><span>3</span><b>Administração</b><small>confere e gera a O.S</small><em>${emitMes.length} O.S no mês · ${fmtBRL(sumArr(emitMes.map(oseValor)))}</em></div>
      <div><span>4</span><b>Combitrans</b><small>assina a O.S (até ${OSE_PRAZO_ASSINATURA} dias)</small><em>${emit.filter(o=>oseSituacao(o).k==="aguardando").length} aguardando assinatura</em></div>
      <div><span>5</span><b>NF emitida</b><small>após o retorno assinado</small><em>${emit.filter(o=>oseSituacao(o).k==="assinada").length} pendente(s) de NF</em></div>
    </div>
    ${oseEditorHTML()}
    ${osePlanoHTML()}

    <div class="panel ose-bloco pre" style="margin:16px 0;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
        <div><h3 style="margin:0;">📤 Pré O.S validadas pelo líder — conferência da administração</h3>
          <div class="hint">Confira cada Pré O.S e gere a O.S. A O.S é um lançamento novo; a Pré O.S fica registrada como a operação lançou.</div></div>
        <div class="prog-chips" style="margin:0;">
          <button class="sub-tab-btn ${OSE_FILTRO==="pre"?"active":""}" onclick="oseFiltro('pre')">Para conferir (${pre.length})</button>
          <button class="sub-tab-btn ${OSE_FILTRO==="validada"?"active":""}" onclick="oseFiltro('validada')">Já viraram O.S (${validadas.length})</button>
          ${listaPre.length ? `<button class="os-btn" onclick="osePreImprimir()" title="Abre todas as Pré O.S desta lista em PDF, com todas as informações">🖨️ Visualizar / imprimir</button>` : ""}
        </div>
      </div>
      ${listaPre.length ? `<div style="overflow-x:auto; margin-top:10px;"><table class="nf-tab">
        <thead><tr><th>Plano de</th><th>Frota · Placa</th><th>Serviços</th><th class="num">Valor estimado</th><th>Operação</th><th>Situação</th><th></th></tr></thead>
        <tbody>${listaPre.map(o=>{ const os = oseDaPre(o.id); return `<tr ${destaque(o)}>
          <td><b>${oseDiaPlano(o) ? fmtDataBR(oseDiaPlano(o)) : "—"}</b></td>
          <td><b>${osEsc(o.frota)}</b>${o.placa ? ` · ${osEsc(o.placa)}` : ""}</td>
          <td class="ose-chips">${resumoItens(o) || "—"}</td>
          <td class="num">${fmtBRL2(oseValor(o))}</td>
          <td style="font-size:12px;">lançou: ${osEsc(o.por||"—")}${o.liderPor ? `<div class="hint" style="margin:0;">líder: ${osEsc(o.liderPor)}${o.liderEm ? ` · ${fmtDataBR(o.liderEm.slice(0,10))}` : ""}</div>` : ""}</td>
          <td>${o.status==="pre" ? `<span class="badge amber">📤 Para conferir</span>` : `<span class="badge green">✅ O.S ${os ? oseNum(os.numero) : ""}</span>`}</td>
          <td style="white-space:nowrap;">${o.status==="pre"
            ? `<button class="os-btn sm green" onclick="oseConferir('${o.id}')">🔎 Conferir e gerar O.S</button> <button class="os-link" onclick="osePreImprimir('${o.id}')" title="Ver / imprimir esta Pré O.S">🖨️</button> <button class="os-link" onclick="oseReabrir('${o.id}')" title="Devolver para a operação">↩</button> <button class="os-link" onclick="oseExcluir('${o.id}')" title="Excluir Pré O.S">🗑️</button>`
            : `<button class="os-link" onclick="osePreImprimir('${o.id}')" title="Ver / imprimir esta Pré O.S">🖨️</button> <span class="hint" style="margin:0;">${os && os.emitidaPor ? `por ${osEsc(os.emitidaPor)}` : ""}</span>`}</td>
        </tr>`; }).join("")}</tbody>
      </table></div>` : `<div class="empty-state" style="padding:16px;"><p>${OSE_FILTRO==="pre" ? `Nenhuma Pré O.S aguardando conferência. ✓${emLanc.length ? ` (${emLanc.length} ainda em lançamento — falta o líder validar)` : ""}` : "Nenhuma Pré O.S virou O.S ainda."}</p></div>`}
    </div>

    <div class="panel ose-bloco os" style="margin:16px 0;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
        <div><h3 style="margin:0;">🧾 O.S emitidas — enviadas para a Combitrans (${emit.length})</h3>
          <div class="hint">Lançamentos da administração. Excluir uma O.S que veio de Pré O.S devolve a Pré O.S para conferência.</div></div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          ${emit.length ? `<button class="os-btn ${OSE_PROT ? "green" : ""}" onclick="oseProtAbrir()" title="Folha de rosto com a faixa de O.S e o dia da emissão, para a Combitrans assinar">📋 Protocolo de entrega</button>` : ""}
          <button class="os-btn" onclick="oseNova()">+ O.S avulsa</button>
        </div>
      </div>
      ${oseProtHTML()}
      <div class="prog-chips" style="margin:10px 0 0;">
        <button class="sub-tab-btn ${OSE_OS_FILTRO==="todas"?"active":""}" onclick="oseOSFiltro('todas')">Todas (${emit.length})</button>
        <button class="sub-tab-btn ${OSE_OS_FILTRO==="aguardando"?"active":""}" onclick="oseOSFiltro('aguardando')">⏳ Aguardando assinatura (${contSit.aguardando})</button>
        <button class="sub-tab-btn ${OSE_OS_FILTRO==="assinada"?"active":""}" onclick="oseOSFiltro('assinada')">✍️ Assinadas — pendentes de NF (${contSit.assinada})</button>
        <button class="sub-tab-btn ${OSE_OS_FILTRO==="nf"?"active":""}" onclick="oseOSFiltro('nf')">🧾 NF emitida (${contSit.nf})</button>
      </div>
      ${listaOS.length ? `<div style="overflow-x:auto; margin-top:10px;"><table class="nf-tab">
        <thead><tr><th>Nº O.S</th><th>Início</th><th>Saída</th><th>Frota · Placa</th><th>Serviços</th><th class="num">Valor p/ NF</th><th>Situação</th><th>Origem</th><th></th></tr></thead>
        <tbody>${listaOS.map(o=>{ const pr = OSE.lista.find(x=>x.id===o.preId); return `<tr ${destaque(o)}>
          <td><b>${oseNum(o.numero)}</b>${o.referencia ? `<div class="hint" style="margin:0;">${osEsc(o.referencia)}</div>` : ""}</td>
          <td>${o.entrada ? fmtDataBR(o.entrada) : "—"}${o.entradaHora ? `<div class="hint" style="margin:0;">${o.entradaHora}</div>` : ""}</td>
          <td>${o.saida ? fmtDataBR(o.saida) : "—"}${o.saidaHora ? `<div class="hint" style="margin:0;">${o.saidaHora}</div>` : ""}</td>
          <td><b>${osEsc(o.frota)}</b>${o.placa ? ` · ${osEsc(o.placa)}` : ""}</td>
          <td class="ose-chips">${resumoItens(o) || "—"}</td>
          <td class="num"><b>${fmtBRL2(oseValor(o))}</b>${pr && Math.abs(oseValor(pr) - oseValor(o)) > 0.005 ? `<div class="hint" style="margin:0;">Pré O.S: ${fmtBRL2(oseValor(pr))}</div>` : ""}</td>
          <td>${oseSituacaoHTML(o)}</td>
          <td style="font-size:12px;">${pr ? `📝 Pré O.S de ${osEsc(pr.por||"operação")}` : "avulsa"}${o.emitidaPor ? `<div class="hint" style="margin:0;">emitida por ${osEsc(o.emitidaPor)}${o.emitidaEm ? ` · ${fmtDataBR(o.emitidaEm.slice(0,10))}` : ""}</div>` : ""}</td>
          <td style="white-space:nowrap;"><button class="os-btn sm" onclick="osePDF('${o.id}')">📄 PDF</button> <button class="os-btn sm green" onclick="oseEnviar('${o.id}')">📲 Enviar</button>
            <button class="os-link" onclick="oseConferir('${o.id}')" title="Editar O.S">✏️</button> <button class="os-link" onclick="oseExcluir('${o.id}')" title="Excluir O.S">🗑️</button></td>
        </tr>`; }).join("")}</tbody>
        <tfoot><tr style="font-weight:800; background:var(--paper);"><td colspan="5">Total (${listaOS.length})</td><td class="num">${fmtBRL2(sumArr(listaOS.map(oseValor)))}</td><td colspan="3"></td></tr></tfoot>
      </table></div>` : `<div class="empty-state" style="padding:16px;"><p>${emit.length ? "Nenhuma O.S nesta situação." : "Nenhuma O.S emitida ainda."}</p></div>`}
    </div>

    <details class="panel" id="ose-cfg" style="margin-bottom:16px;" ${OSE.cfgSalvo ? "" : "open"}>
      <summary style="cursor:pointer; font-weight:700;">🏢 Cabeçalho da O.S (dados da Avance e do cliente) ${OSE.cfgSalvo ? "" : '<span class="badge amber">confira e salve</span>'}</summary>
      ${OSE.cfgSalvo ? "" : `<div class="os-alerta amber" style="margin-top:8px;">Estes dados foram lidos da foto do modelo da O.S — <b>confira CNPJ e endereços</b> e clique em Salvar. Eles saem no PDF de toda O.S.</div>`}
      <div class="nf-grid os-form" style="grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); margin-top:8px;">
        ${[["empresa","Empresa"],["razao","Razão social"],["cnpj","CNPJ"],["endereco","Endereço"],["cep","CEP"],["cliente","Cliente"],["clienteEndereco","Endereço do cliente"],["clienteCnpj","CNPJ do cliente"]]
          .map(([k,l])=>`<label>${l}<input id="ose-cfg-${k}" value="${osEsc(cfg[k]||"")}"></label>`).join("")}
      </div>
      ${osePodeEmitir() ? `<button class="entry-submit" style="margin-top:10px;" onclick="oseSalvarCfg()">💾 Salvar cabeçalho</button>` : ""}
    </details>
    <details class="panel" style="margin-bottom:16px;" ${OSE.servicos.length ? "" : "open"}>
      <summary style="cursor:pointer; font-weight:700;">📥 Tabela de serviços e preços <span class="hint" style="margin:0;">· ${OSE.servicos.length} serviços</span></summary>
      <div class="hint" style="margin-top:8px;">Escolha a planilha <b>"TABELA DE SERVIÇO 2026 - CARRETA"</b> para atualizar códigos e preços (M.OBRA / MATERIAL). A tabela é substituída pela da planilha; as O.S já lançadas guardam o preço do dia.</div>
      <input type="file" id="ose-tab-file" accept=".xlsx,.xls" style="font-size:12.5px;"> <button class="entry-submit" style="margin-top:10px;" onclick="oseImportarTabela()">Importar tabela de serviços</button>
      <div id="ose-tab-st" class="hint" style="margin-top:8px;"></div>
    </details>`;
}

/* -------------------- CONTROLE DIÁRIO DE CARRETAS (aba da Manutenção de Carreta) --------------------
   Para o líder da oficina: cada carreta que o cliente traz entra na FILA do pátio; ao ficar pronta é
   marcada como concluída no dia. Por dia: Planejado (meta informada pelo líder), Realizado (concluídas),
   Diferença, Recebidas (novas que chegaram) e Fila no pátio ao fim do dia. Lista de carretas = a mesma da
   O.S de Manutenção (tabela os_carretas). Tabelas: carretas_fila e carretas_plano. */
let MAN_ABA = "custos";               // custos | diario
let CAR = { fila:[], plano:{}, carretas:[], carregado:false, carregando:false, erro:null, mesCarregado:null };
let CAR_DIA = frotaHojeISO();
const CAR_LOCAL = "avance_carretas_local_v1";

window.setManAba = (a) => { MAN_ABA = a; navigate("manutencao"); };
function carRotulo(c){ return c.frota && c.frota!==c.placa ? `${c.frota} · ${c.placa}` : c.placa; }
function carAchar(txt){
  const t = String(txt||"").toUpperCase().replace(/\s+/g," ").trim(); if(!t) return null;
  const sem = t.replace(/[\s·.\-]/g,"");
  return CAR.carretas.find(c=>carRotulo(c).toUpperCase()===t) || CAR.carretas.find(c=>c.placa.replace(/[\s-]/g,"")===sem) || CAR.carretas.find(c=>String(c.frota)===t) || null;
}
async function carCarregar(silencioso){
  if(!silencioso) CAR.carregando = true;
  if(!sb){
    try{ const d = JSON.parse(localStorage.getItem(CAR_LOCAL)||"{}"); CAR.fila = d.fila||[]; CAR.plano = d.plano||{}; }catch(e){}
    CAR.carregado = true; CAR.carregando = false; carRerender(); return;
  }
  const [f, p, c] = await Promise.all([ sbFetchAll("carretas_fila"), sbFetchAll("carretas_plano"), CAR.carretas.length ? Promise.resolve(null) : sbFetchAll("os_carretas") ]);
  const t = await sb.from("carretas_fila").select("id").limit(1);
  if(t.error){ CAR.erro = t.error.message; CAR.carregando = false; CAR.carregado = true; carRerender(); return; }
  CAR.erro = null;
  CAR.fila = f.map(r=>({ id:r.id, frota:r.frota||"", placa:r.placa||"", entrada:r.data_entrada, conclusao:r.data_conclusao||"", obs:r.obs||"", por:(r.atualizado_por||r.criado_por||"").split("@")[0] }));
  CAR.plano = {}; p.forEach(r=>{ CAR.plano[r.data] = { planejado:Number(r.planejado)||0, obs:r.obs||"" }; });
  if(c) CAR.carretas = c.map(x=>({ placa:x.placa, frota:String(x.frota) })).sort((a,b)=>a.frota.localeCompare(b.frota, undefined, { numeric:true }));
  CAR.carregado = true; CAR.carregando = false;
  const assin = JSON.stringify([CAR.fila, CAR.plano]); const mudou = assin !== CAR.assin; CAR.assin = assin;
  if(!silencioso || mudou) carRerender();
}
function carSalvarLocal(){ if(!sb) try{ localStorage.setItem(CAR_LOCAL, JSON.stringify({ fila:CAR.fila, plano:CAR.plano })); }catch(e){} }
function carRerender(){
  if(document.querySelector('nav.menu button.active')?.dataset.page !== "manutencao" || MAN_ABA !== "diario") return;
  const foco = document.activeElement;
  if(foco && foco.closest && (foco.closest("#car-form") || foco.closest("#ose-form")) && /INPUT|SELECT|TEXTAREA/.test(foco.tagName)) return;
  const y = window.scrollY; document.getElementById("content").innerHTML = renderers.manutencao(); window.scrollTo(0,y);
  requestAnimationFrame(carGrafico);
}
setInterval(()=>{ if(sb && MAN_ABA==="diario" && document.visibilityState==="visible" && document.querySelector('nav.menu button.active')?.dataset.page==="manutencao") carCarregar(true); }, 30000);

// Situação de um dia
function carDia(d){
  const recebidas = CAR.fila.filter(c=>c.entrada===d);
  const realizadas = CAR.fila.filter(c=>c.conclusao===d);
  const filaFim = CAR.fila.filter(c=>c.entrada<=d && (!c.conclusao || c.conclusao>d));
  const filaInicio = CAR.fila.filter(c=>c.entrada<d && (!c.conclusao || c.conclusao>=d));
  const plano = CAR.plano[d] || { planejado:0, obs:"" };
  return { recebidas, realizadas, filaFim, filaInicio, planejado:plano.planejado, obsPlano:plano.obs };
}

window.carSetDia = (d) => { if(d){ CAR_DIA = d; carRerender(); } };
window.carMoverDia = (n) => { const d = new Date(CAR_DIA+"T12:00:00"); d.setDate(d.getDate()+n); carSetDia(d.toISOString().slice(0,10)); };
window.carSalvarPlano = async (valor) => {
  const n = Math.max(0, parseInt(valor,10)||0);
  CAR.plano[CAR_DIA] = { ...(CAR.plano[CAR_DIA]||{}), planejado:n };
  if(sb){ const { error } = await sb.from("carretas_plano").upsert({ data:CAR_DIA, planejado:n, obs:CAR.plano[CAR_DIA].obs||null, atualizado_por:MEU_EMAIL, atualizado_em:new Date().toISOString() }, { onConflict:"data" });
    if(error){ toast("⚠ Não salvou: " + error.message); return; } }
  carSalvarLocal(); toast(`Planejado de ${frotaDataBR(CAR_DIA)}: ${n} carreta(s) ✓`); carRerender();
};
window.carSalvarObsPlano = async (txt) => {
  CAR.plano[CAR_DIA] = { planejado:(CAR.plano[CAR_DIA]||{}).planejado||0, obs:txt.trim() };
  if(sb){ const { error } = await sb.from("carretas_plano").upsert({ data:CAR_DIA, planejado:CAR.plano[CAR_DIA].planejado, obs:CAR.plano[CAR_DIA].obs||null, atualizado_por:MEU_EMAIL, atualizado_em:new Date().toISOString() }, { onConflict:"data" });
    if(error){ toast("⚠ Não salvou: " + error.message); return; } }
  carSalvarLocal(); toast("Observação salva ✓");
};
window.carReceber = async () => {
  const el = document.getElementById("car-nova"); const txt = (el?.value||"").trim(); if(!txt){ toast("Informe a frota ou a placa."); return; }
  const c = carAchar(txt);
  const frota = c ? c.frota : txt.toUpperCase(), placa = c ? c.placa : "";
  if(CAR.fila.some(x=>!x.conclusao && x.entrada<=CAR_DIA && (x.frota===frota || (placa && x.placa===placa))) && !confirm(`${frota} já está na fila do pátio. Registrar outra entrada?`)) return;
  const reg = { id:"tmp"+osNovoId(), frota, placa, entrada:CAR_DIA, conclusao:"", obs:"", por:(MEU_EMAIL||"").split("@")[0] };
  if(sb){ const { data, error } = await sb.from("carretas_fila").insert({ frota, placa:placa||null, data_entrada:CAR_DIA, criado_por:MEU_EMAIL, atualizado_por:MEU_EMAIL }).select().single();
    if(error){ toast("⚠ Não salvou: " + error.message); return; } reg.id = data.id; }
  CAR.fila.push(reg); carSalvarLocal();
  el.value = ""; carRerender(); setTimeout(()=>document.getElementById("car-nova")?.focus(), 50);
  toast(`${frota} entrou na fila ✓`);
};
window.carConcluir = async (id, desfazer) => {
  const c = CAR.fila.find(x=>x.id===id); if(!c) return;
  const nova = desfazer ? "" : CAR_DIA;
  if(sb){ const { error } = await sb.from("carretas_fila").update({ data_conclusao:nova||null, atualizado_por:MEU_EMAIL, atualizado_em:new Date().toISOString() }).eq("id", id);
    if(error){ toast("⚠ Não salvou: " + error.message); return; } }
  c.conclusao = nova; carSalvarLocal(); carRerender();
};
window.carExcluir = async (id) => {
  const c = CAR.fila.find(x=>x.id===id); if(!c || !confirm(`Excluir o lançamento da carreta ${c.frota} (entrada ${frotaDataBR(c.entrada)})?`)) return;
  if(sb){ const { error } = await sb.from("carretas_fila").delete().eq("id", id); if(error){ toast("⚠ Não excluiu: " + error.message); return; } }
  CAR.fila = CAR.fila.filter(x=>x.id!==id); carSalvarLocal(); carRerender();
};

function carTextoWhatsApp(){
  const D = carDia(CAR_DIA), dif = D.planejado - D.realizadas.length;
  const pct = D.planejado ? Math.round(D.realizadas.length/D.planejado*100) : 0;
  let t = `🔧 *MANUTENÇÃO DE CARRETAS*\n📅 ${frotaDataBR(CAR_DIA)} (${progDiaSemana(CAR_DIA)})\n\n`;
  t += `📋 Planejado: *${D.planejado}*\n✅ Realizado: *${D.realizadas.length}*\n`;
  t += `${dif>0 ? "⏳" : "✔️"} Diferença: *${dif>0 ? dif : 0}*${dif<0 ? ` (${-dif} acima do plano)` : ""}\n`;
  t += `🚚 Recebidas do cliente no dia: *${D.recebidas.length}*\n🅿️ Fila no pátio (fim do dia): *${D.filaFim.length}*\n`;
  if(D.planejado) t += `🎯 Atendimento: *${pct}%*\n`;
  if(D.obsPlano) t += `\n📝 ${D.obsPlano}\n`;
  if(D.realizadas.length) t += `\n*Realizadas:* ${D.realizadas.map(c=>c.frota).join(", ")}\n`;
  if(D.recebidas.length) t += `*Recebidas:* ${D.recebidas.map(c=>c.frota).join(", ")}\n`;
  return t.trim();
}
window.carCopiarWhatsApp = async () => {
  const txt = carTextoWhatsApp();
  try{ await navigator.clipboard.writeText(txt); toast("Mensagem copiada ✓ — é só colar no WhatsApp"); }
  catch(e){ document.getElementById("car-wpp")?.select(); toast("Selecione o texto e copie (Ctrl+C)."); }
};
window.carAbrirWhatsApp = () => window.open("https://wa.me/?text=" + encodeURIComponent(carTextoWhatsApp()), "_blank");

// Importa a lista de carretas (aba de placas da planilha "TABELA DE SERVIÇO 2026 - CARRETA") para a tabela
// os_carretas. A aba tem blocos de formatos diferentes (QT·PLACA·FROTA e QT·PLACA·(vazio)·FROTA): para cada
// célula com cara de placa, a frota é o próximo valor à direita e só vale se for nº de frota de verdade
// (ex: 2021, CB1101) — senão a carreta fica identificada só pela placa. Placas repetidas entram uma vez.
window.carImportarCarretas = async () => {
  const file = document.getElementById("car-tab-file")?.files[0], st = document.getElementById("car-tab-st");
  if(!file){ st.textContent = "⚠ Escolha a planilha primeiro."; return; }
  st.textContent = "Lendo planilha...";
  try{
    const wb = XLSX.read(await file.arrayBuffer(), { type:"array" });
    const PL = /^[A-Z]{3}-?[0-9][A-Z0-9][0-9]{2}$/i, FROTA_OK = /^(CB)?\d{3,5}$/i, porPlaca = {};
    wb.SheetNames.forEach(nome=>{
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header:1, defval:null });
      if(!rows.slice(0,6).some(r=>r && r.some(c=>String(c||"").trim().toUpperCase()==="PLACA"))) return;
      rows.slice(2).forEach(r=>{ if(!r) return; r.forEach((v,c)=>{
        if(v==null || !PL.test(String(v).trim())) return;
        const viz = [r[c+1], r[c+2]].find(x=>x!=null && String(x).trim()!=="" && !PL.test(String(x).trim()));
        const placa = String(v).trim().toUpperCase(), f = viz!=null ? String(viz).trim().toUpperCase() : "";
        const c2 = { placa, frota: FROTA_OK.test(f) ? f : placa }, a = porPlaca[placa];
        if(!a || (a.frota===a.placa && c2.frota!==c2.placa)) porPlaca[placa] = c2;
      }); });
    });
    const carretas = Object.values(porPlaca);
    if(!carretas.length){ st.textContent = "⚠ Não encontrei a aba de placas (com a coluna PLACA) nessa planilha."; return; }
    if(sb){ st.textContent = `Gravando ${carretas.length} carretas...`; await sbSubstituirTabela("os_carretas", carretas); }
    CAR.carretas = carretas.map(c=>({ placa:c.placa, frota:String(c.frota) })).sort((a,b)=>a.frota.localeCompare(b.frota, undefined, { numeric:true }));
    st.innerHTML = `✓ <b>${carretas.length}</b> carretas importadas (${carretas.filter(c=>c.frota!==c.placa).length} com nº de frota).`;
    toast("Lista de carretas atualizada ✓"); setTimeout(()=>carRerender(), 800);
  }catch(e){ st.textContent = "⚠ " + (e.message||e); }
};

function carPagina(){
  if(!CAR.carregado && !CAR.carregando){ CAR.carregando = true; setTimeout(()=>carCarregar(), 0); }
  if(CAR.erro) return `<div class="panel"><div class="empty-state" style="padding:24px;"><div class="glyph">⚠️</div><h4>Não foi possível carregar o controle de carretas</h4><p>${osEsc(CAR.erro)}</p><p>Se falar em tabela inexistente ("carretas_fila"), rode o SQL do controle de carretas no Supabase.</p></div></div>`;
  if(CAR.carregando && !CAR.carregado) return `<div class="panel"><div class="empty-state" style="padding:24px;"><div class="glyph">⏳</div><p>Carregando...</p></div></div>`;
  oseGarantirCarga();
  const D = carDia(CAR_DIA), hoje = CAR_DIA === frotaHojeISO();
  const dif = D.planejado - D.realizadas.length;
  const pct = D.planejado ? D.realizadas.length/D.planejado*100 : 0;
  const filaAgora = D.filaFim.sort((a,b)=>a.entrada.localeCompare(b.entrada));
  const mes = CAR_DIA.slice(0,7), nomeMes = `${MESES_HE[Number(mes.slice(5,7))-1]}/${mes.slice(2,4)}`;
  const doMesReal = CAR.fila.filter(c=>c.conclusao.startsWith(mes)).length, doMesRec = CAR.fila.filter(c=>c.entrada.startsWith(mes)).length;
  const doMesPlan = sumArr(Object.entries(CAR.plano).filter(([d])=>d.startsWith(mes)).map(([,p])=>p.planejado||0));
  return `
    <div class="panel" style="margin-bottom:16px;">
      <div class="prog-topo">
        <div class="prog-dia">
          <button class="os-btn" onclick="carMoverDia(-1)">◀</button>
          <input type="date" value="${CAR_DIA}" onchange="carSetDia(this.value)">
          <button class="os-btn" onclick="carMoverDia(1)">▶</button>
          ${hoje ? `<span class="badge green">hoje</span>` : `<button class="os-link" onclick="carSetDia('${frotaHojeISO()}')">ir para hoje</button>`}
          <b style="text-transform:capitalize;">${progDiaSemana(CAR_DIA)}</b>
        </div>
        ${sb ? `<span class="hint" style="margin:0;">🟢 compartilhado · atualiza sozinho a cada 30s</span>` : `<span class="hint" style="margin:0;">🧪 modo local</span>`}
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">📋 Planejado</div><div class="val"><input type="number" min="0" class="car-plan" value="${D.planejado||""}" placeholder="0" onchange="carSalvarPlano(this.value)"></div><div class="delta flat">meta do dia — digite e saia do campo</div></div>
      <div class="kpi"><div class="lbl">✅ Realizado</div><div class="val" style="color:var(--green);">${D.realizadas.length}</div><div class="delta flat">${D.planejado ? `${pct.toFixed(0)}% do planejado` : "informe o planejado"}</div></div>
      <div class="kpi"><div class="lbl">⏳ Diferença</div><div class="val" style="color:var(--${dif>0?"red":"green"});">${dif>0 ? dif : 0}</div><div class="delta flat">${dif<0 ? `${-dif} acima do plano` : "planejado − realizado"}</div></div>
      <div class="kpi"><div class="lbl">🚚 Recebidas no dia</div><div class="val">${D.recebidas.length}</div><div class="delta flat">novas trazidas pelo cliente</div></div>
      <div class="kpi"><div class="lbl">🅿️ Fila no pátio</div><div class="val" style="color:var(--${D.filaFim.length?"amber":"green"});">${D.filaFim.length}</div><div class="delta flat">começou o dia com ${D.filaInicio.length}</div></div>
    </div>

    ${!sb || MEU_PAPEL==="diretor" ? `<details class="panel" style="margin-bottom:16px;" ${CAR.carretas.length ? "" : "open"}>
      <summary style="cursor:pointer; font-weight:700;">📥 Lista de carretas <span class="hint" style="margin:0;">· ${CAR.carretas.length} cadastradas</span></summary>
      <div class="hint" style="margin-top:8px;">Para atualizar, escolha a planilha <b>"TABELA DE SERVIÇO 2026 - CARRETA"</b> (aba de placas). A lista é substituída pela da planilha.</div>
      <input type="file" id="car-tab-file" accept=".xlsx,.xls" style="font-size:12.5px;"> <button class="entry-submit" style="margin-top:10px;" onclick="carImportarCarretas()">Importar lista de carretas</button>
      <div id="car-tab-st" class="hint" style="margin-top:8px;"></div>
    </details>` : ""}

    <div class="panel os-form" id="car-form" style="margin-bottom:16px;">
      <h3 style="margin:0;">🚚 Registrar carreta recebida — ${frotaDataBR(CAR_DIA)}</h3>
      <div class="hint">Digite o nº da frota ou a placa e tecle Enter. Ela entra na fila do pátio.</div>
      <div class="car-add">
        <input id="car-nova" list="car-l" placeholder="nº da frota ou placa" autocomplete="off" style="text-transform:uppercase;" onkeydown="if(event.key==='Enter') carReceber()">
        <button class="entry-submit" style="margin:0;" onclick="carReceber()">+ Entrou na fila</button>
      </div>
      <datalist id="car-l">${CAR.carretas.map(c=>`<option value="${osEsc(carRotulo(c))}">`).join("")}</datalist>
      <label>Observação do dia (vai para o WhatsApp)<input value="${osEsc(D.obsPlano)}" placeholder="ex: 2 mecânicos de folga" onchange="carSalvarObsPlano(this.value)"></label>
    </div>
    ${OSE_EDIT ? `<div style="margin-bottom:16px;">${oseEditorHTML()}</div>` : ""}
    ${osePlanoHTML(CAR_DIA)}

    <div class="grid-2">
      <div class="panel">
        <h3>🅿️ Fila do pátio (${filaAgora.length})</h3>
        <div class="hint">Carretas aguardando manutenção ao fim de ${frotaDataBR(CAR_DIA)}. Lance os serviços em <b>📝 Pré O.S</b> e marque ✅ quando ficar pronta.</div>
        ${filaAgora.length ? `<table class="nf-tab"><thead><tr><th>Frota</th><th>Placa</th><th>Entrada</th><th class="num">No pátio</th><th>Pré O.S</th><th></th></tr></thead><tbody>
          ${filaAgora.map(c=>{ const dias = nfeDias(c.entrada, CAR_DIA); return `<tr><td><b>${osEsc(c.frota)}</b></td><td>${osEsc(c.placa)||"—"}</td><td>${frotaDataBR(c.entrada)}</td>
            <td class="num"><span class="badge ${dias>=3?"red":dias>=1?"amber":"gray"}">${dias} dia(s)</span></td>
            <td style="white-space:nowrap;">${osePreCelula(c)}</td>
            <td style="white-space:nowrap;"><button class="os-btn sm green" onclick="carConcluir('${c.id}')">✅ Pronta</button> <button class="os-link" onclick="carExcluir('${c.id}')" title="Excluir lançamento">🗑️</button></td></tr>`; }).join("")}
        </tbody></table>` : `<div class="empty-state" style="padding:16px;"><p>Pátio vazio. ✓</p></div>`}
      </div>
      <div class="panel">
        <h3>✅ Realizadas em ${frotaDataBR(CAR_DIA)} (${D.realizadas.length})</h3>
        ${D.realizadas.length ? `<table class="nf-tab"><thead><tr><th>Frota</th><th>Placa</th><th>Entrada</th><th class="num">Tempo</th><th>Pré O.S</th><th></th></tr></thead><tbody>
          ${D.realizadas.map(c=>`<tr><td><b>${osEsc(c.frota)}</b></td><td>${osEsc(c.placa)||"—"}</td><td>${frotaDataBR(c.entrada)}</td><td class="num">${nfeDias(c.entrada, c.conclusao)} dia(s)</td>
            <td style="white-space:nowrap;">${osePreCelula(c)}</td>
            <td><button class="os-link" onclick="carConcluir('${c.id}', true)">desfazer</button></td></tr>`).join("")}
        </tbody></table>` : `<div class="empty-state" style="padding:16px;"><p>Nenhuma carreta concluída neste dia.</p></div>`}
        ${D.recebidas.length ? `<div class="hint" style="margin-top:10px;"><b>Recebidas no dia (${D.recebidas.length}):</b> ${D.recebidas.map(c=>osEsc(c.frota)).join(", ")}</div>` : ""}
      </div>
    </div>

    <div class="panel" style="margin:16px 0;">
      <h3>💬 Mensagem do dia para o WhatsApp</h3>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="entry-submit" style="margin-top:0;" onclick="carCopiarWhatsApp()">📋 Copiar mensagem</button>
        <button class="os-btn green" onclick="carAbrirWhatsApp()">🟢 Abrir no WhatsApp</button>
      </div>
      <textarea id="car-wpp" readonly class="frota-wpp">${osEsc(carTextoWhatsApp())}</textarea>
    </div>

    <div class="panel" style="margin-bottom:16px;">
      <h3>📊 Planejado x Realizado por dia — ${nomeMes}</h3>
      <div class="os-resumo prog-resumo" style="margin:4px 0 12px;">
        <div>Planejado no mês<b>${doMesPlan}</b></div>
        <div>Realizado no mês<b style="color:var(--green);">${doMesReal}</b></div>
        <div>Recebidas no mês<b>${doMesRec}</b></div>
        <div>Atendimento do plano<b>${doMesPlan ? Math.round(doMesReal/doMesPlan*100) : 0}%</b></div>
      </div>
      <div class="chart-wrap" style="height:300px;"><canvas id="ch-car"></canvas></div>
      <div class="hint" style="margin:8px 0 0;">Barra cinza = planejado · vermelha = realizado · número = realizado/planejado. Passe o mouse para ver recebidas e fila.</div>
    </div>`;
}
function carGrafico(){
  const el = document.getElementById("ch-car"); if(!el) return;
  const mes = CAR_DIA.slice(0,7), hoje = frotaHojeISO();
  const nDias = new Date(Number(mes.slice(0,4)), Number(mes.slice(5,7)), 0).getDate();
  const dias = Array.from({ length:nDias }, (_,i)=>`${mes}-${String(i+1).padStart(2,"0")}`).filter(d=>mes!==hoje.slice(0,7) || d<=hoje);
  const D = dias.map(d=>{ const x = carDia(d); return { d, plan:x.planejado, real:x.realizadas.length, rec:x.recebidas.length, fila:x.filaFim.length }; });
  const mobile = (el.parentElement.clientWidth || window.innerWidth) < 600;
  el.parentElement.style.height = mobile ? `${Math.max(220, D.length*30+70)}px` : "300px";
  const SEM = ["dom","seg","ter","qua","qui","sex","sáb"], sem = (d)=>SEM[new Date(d+"T12:00:00").getDay()];
  mkChart("ch-car", {
    type:"bar",
    data:{ labels:D.map(x=>mobile ? `${x.d.slice(8,10)} ${sem(x.d)}` : [x.d.slice(8,10), sem(x.d)]),
      datasets:[
        { label:"Planejado", data:D.map(x=>x.plan), backgroundColor:"#D5D7DF", borderRadius:5, grouped:false, order:2, barPercentage:0.85 },
        { label:"Realizado", data:D.map(x=>x.real), backgroundColor:COLORS.red, borderRadius:4, grouped:false, order:1, barPercentage:0.45 } ]},
    options:{ responsive:true, maintainAspectRatio:false, indexAxis: mobile ? "y" : "x",
      onClick:(_e, els)=>{ if(els.length) carSetDia(D[els[0].index].d); },
      plugins:{ legend:{ position: mobile ? "top" : "bottom", labels:{ boxWidth:12, usePointStyle:true, pointStyle:"rectRounded" } },
        tooltip:{ mode:"index", intersect:false, callbacks:{ afterBody:(its)=>{ const x = D[its[0].dataIndex]; return [`Recebidas: ${x.rec}`, `Fila no fim do dia: ${x.fila}`]; } } },
        datalabels:{ display:(c)=>{ const x = D[c.dataIndex]; if(!(x.plan||x.real)) return false; return c.datasetIndex===0 ? x.plan>=x.real : x.real>x.plan; },
          formatter:(_v,c)=>{ const x = D[c.dataIndex]; return `${x.real}/${x.plan}`; }, color:(c)=>{ const x = D[c.dataIndex]; return !x.plan ? COLORS.inkSoft : x.real>=x.plan ? COLORS.green : COLORS.red; },
          anchor:"end", align: mobile ? "right" : "top", offset:2, clamp:true, font:{ size: mobile ? 11 : 10, weight:800 } } },
      layout:{ padding: mobile ? { right:40 } : { top:18 } },
      scales: mobile ? { y:{ grid:{ display:false } }, x:{ beginAtZero:true, position:"top", ticks:{ precision:0 } } }
                     : { x:{ grid:{ display:false } }, y:{ beginAtZero:true, grid:{ color:COLORS.grid }, ticks:{ precision:0 } } } }
  });
}

renderers.manutencao = () => {
  if(MEU_PAPEL === "oficina") MAN_ABA = "diario";
  const abas = MEU_PAPEL === "oficina" ? "" : `
    <div class="tabs" style="margin-bottom:14px;">
      <button class="tab-btn ${MAN_ABA==="custos"?"active":""}" onclick="setManAba('custos')">💰 Custos</button>
      <button class="tab-btn ${MAN_ABA==="diario"?"active":""}" onclick="setManAba('diario')">🚛 Controle diário de carretas</button>
    </div>`;
  if(MAN_ABA === "diario") return `<div class="page-head"><h2>Controle diário de carretas</h2><p>Planejado x realizado, carretas recebidas do cliente e fila do pátio — dia a dia</p></div>${abas}${carPagina()}`;
  return abas + manutencaoCustos();
};
initCharts.manutencao = () => { if(MAN_ABA === "diario") carGrafico(); else manutencaoCustosCharts(); };
/* -------------------- INFRAÇÕES › SINISTRO --------------------
   Registro de sinistros por placa (lista do Status da Frota): Quem? Como? Quando? Aonde? Análise da
   ocorrência, com evidências (fotos reduzidas no navegador e arquivos) e relatório em PDF para enviar pelo
   WhatsApp. Tabela sinistros (os anexos só são baixados quando abre o registro ou gera o PDF). */
let INF_ABA = "infracoes";      // infracoes | sinistro
window.setInfAba = (a) => { INF_ABA = a; navigate("infracoes"); };
let SIN = { lista:[], veiculos:[], carregado:false, carregando:false, erro:null };
let SIN_FORM = null;
const SIN_LOCAL = "avance_sinistros_v1";
const SIN_MAX_ARQ = 4 * 1024 * 1024;   // arquivos que não são foto: até 4 MB cada
const sinNum = (n) => n ? String(n).padStart(4, "0") : "—";
const SIN_COLS = "id,numero,veiculo_id,placa,data,hora,quem,como,quando,aonde,analise,anexos_qtd,criado_por,created_at";   // sem os anexos (pesados)
const SIN_N_PLANO = 3;   // linhas do plano de ação
const sinPlanoVazio = () => Array.from({ length:SIN_N_PLANO }, () => ({ acao:"", responsavel:"", prazo:"" }));
function sinPlanoNorm(pl){ const l = (Array.isArray(pl) ? pl : []).map(x=>({ acao:x.acao||"", responsavel:x.responsavel||"", prazo:x.prazo||"" })); while(l.length < SIN_N_PLANO) l.push({ acao:"", responsavel:"", prazo:"" }); return l; }
const sinPlanoPreenchido = (pl) => (pl||[]).filter(x=>x.acao || x.responsavel || x.prazo);
async function sinCarregar(){
  SIN.carregando = true;
  if(!sb){ try{ SIN.lista = JSON.parse(localStorage.getItem(SIN_LOCAL)||"[]"); }catch(e){ SIN.lista = []; }
    SIN.veiculos = (typeof frotaVeiculosOrdenados==="function" ? frotaVeiculosOrdenados() : []).map(v=>({ id:v.id, placa:v.placa, ordem:v.ordem, motorista:v.motorista||"" })); }
  else {
    const [l, v] = await Promise.all([
      sb.from("sinistros").select(SIN_COLS + ",plano_acao").order("data", { ascending:false }).then(r=>r.error && /plano_acao/i.test(r.error.message) ? sb.from("sinistros").select(SIN_COLS).order("data", { ascending:false }) : r),
      sb.from("frota_veiculos").select("id,placa,ordem,motorista").order("ordem") ]);
    if(l.error) SIN.erro = l.error.message;
    else { SIN.erro = null; SIN.lista = l.data.map(r=>({ id:r.id, numero:r.numero, veiculoId:r.veiculo_id, placa:r.placa||"", data:r.data||"", hora:r.hora||"", quem:r.quem||"", como:r.como||"", quando:r.quando||"",
      aonde:r.aonde||"", analise:r.analise||"", plano:sinPlanoNorm(r.plano_acao), anexosQtd:r.anexos_qtd||0, anexos:null, por:(r.criado_por||"").split("@")[0] })); }
    if(!v.error) SIN.veiculos = v.data.map(x=>({ id:x.id, placa:x.placa, ordem:x.ordem, motorista:x.motorista||"" }));
  }
  SIN.carregando = false; SIN.carregado = true; sinRedesenhar(true);
}
function sinGarantirCarga(){ if(!SIN.carregado && !SIN.carregando){ SIN.carregando = true; setTimeout(()=>sinCarregar(), 0); } }
function sinSalvarLocal(){ if(!sb) try{ localStorage.setItem(SIN_LOCAL, JSON.stringify(SIN.lista)); }catch(e){ toast("⚠ Sem espaço no navegador para os anexos (modo local)."); } }
function sinRedesenhar(seguro){
  if(document.querySelector('nav.menu button.active')?.dataset.page !== "infracoes" || INF_ABA !== "sinistro") return;
  if(seguro){ const f = document.activeElement; if(f && f.closest && f.closest("#sin-form") && /INPUT|SELECT|TEXTAREA/.test(f.tagName)) return; }
  const y = window.scrollY; document.getElementById("content").innerHTML = renderers.infracoes(); window.scrollTo(0,y);
}
async function sinAnexos(r){
  if(r.anexos) return r.anexos;
  if(!sb) return r.anexos || [];
  const { data, error } = await sb.from("sinistros").select("anexos").eq("id", r.id).single();
  if(error){ toast("⚠ Não carregou os anexos: " + error.message); return []; }
  r.anexos = data.anexos || []; return r.anexos;
}
// guarda o que já foi digitado (o formulário é redesenhado ao incluir anexos)
function sinLerForm(){ const f = SIN_FORM; if(!f) return; const g = (id) => document.getElementById(id);
  ["veiculoId","data","hora","quem","como","quando","aonde","analise"].forEach(k=>{ const el = g(`sin-${k}`); if(el) f[k] = el.value; });
  f.plano = (f.plano || sinPlanoVazio()).map((x, i)=>({ acao:g(`sin-pa-acao-${i}`)?.value ?? x.acao, responsavel:g(`sin-pa-resp-${i}`)?.value ?? x.responsavel, prazo:g(`sin-pa-prazo-${i}`)?.value ?? x.prazo })); }
window.sinNovo = () => { const h = new Date(); SIN_FORM = { id:null, veiculoId:"", data:frotaHojeISO(), hora:`${String(h.getHours()).padStart(2,"0")}:${String(h.getMinutes()).padStart(2,"0")}`, quem:"", como:"", quando:"", aonde:"", analise:"", plano:sinPlanoVazio(), anexos:[] };
  sinRedesenhar(); setTimeout(()=>document.getElementById("sin-form")?.scrollIntoView({ behavior:"smooth", block:"start" }), 60); };
window.sinEditar = async (id) => { const r = SIN.lista.find(x=>x.id===id); if(!r) return; const an = await sinAnexos(r);
  SIN_FORM = { ...r, plano:sinPlanoNorm(r.plano).map(x=>({ ...x })), anexos:an.map(a=>({ ...a })) }; sinRedesenhar(); setTimeout(()=>document.getElementById("sin-form")?.scrollIntoView({ behavior:"smooth", block:"start" }), 60); };
window.sinCancelar = () => { SIN_FORM = null; sinRedesenhar(); };
window.sinPlaca = (vid) => { sinLerForm(); const v = SIN.veiculos.find(x=>x.id===vid); if(SIN_FORM && v && !SIN_FORM.quem) SIN_FORM.quem = v.motorista || ""; sinRedesenhar(); };
function sinReduzirFoto(file){
  return new Promise((ok, erro)=>{ const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { const k = Math.min(1, 1280 / Math.max(img.width, img.height)), c = document.createElement("canvas");
      c.width = Math.round(img.width*k); c.height = Math.round(img.height*k); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); ok({ nome:file.name, tipo:"image/jpeg", dados:c.toDataURL("image/jpeg", 0.74), w:c.width, h:c.height }); };
    img.onerror = () => { URL.revokeObjectURL(url); erro(new Error("imagem ilegível")); }; img.src = url; });
}
function sinLerArquivo(file){ return new Promise((ok, erro)=>{ const fr = new FileReader(); fr.onload = () => ok({ nome:file.name, tipo:file.type || "application/octet-stream", dados:fr.result }); fr.onerror = () => erro(fr.error); fr.readAsDataURL(file); }); }
window.sinAddAnexos = async (input) => {
  sinLerForm(); const f = SIN_FORM; if(!f) return;
  const arqs = [...(input.files||[])]; let n = 0;
  for(const a of arqs){
    try{
      if(/^image\//.test(a.type)) f.anexos.push(await sinReduzirFoto(a));
      else if(a.size > SIN_MAX_ARQ){ toast(`⚠ ${a.name} passa de 4 MB — não foi anexado.`); continue; }
      else f.anexos.push(await sinLerArquivo(a));
      n++;
    }catch(e){ toast(`⚠ Não foi possível ler ${a.name}.`); }
  }
  if(n) toast(`${n} anexo(s) incluído(s) ✓`); sinRedesenhar();
};
window.sinTirarAnexo = (i) => { sinLerForm(); if(SIN_FORM){ SIN_FORM.anexos.splice(i, 1); sinRedesenhar(); } };
window.sinVerAnexo = async (id, i) => {
  const r = id ? SIN.lista.find(x=>x.id===id) : null; const an = r ? await sinAnexos(r) : (SIN_FORM ? SIN_FORM.anexos : []); const a = an[i]; if(!a) return;
  if(/^image\//.test(a.tipo)){ const d = document.createElement("div"); d.className = "frota-foto-modal"; d.onclick = () => d.remove();
    d.innerHTML = `<div><img src="${a.dados}" alt="${osEsc(a.nome)}"><p><b>${osEsc(a.nome)}</b><br><small>toque para fechar</small></p></div>`; document.body.appendChild(d); }
  else { const l = document.createElement("a"); l.href = a.dados; l.download = a.nome; document.body.appendChild(l); l.click(); l.remove(); }
};
window.sinSalvar = async () => {
  sinLerForm(); const f = SIN_FORM; if(!f) return;
  const v = SIN.veiculos.find(x=>x.id===f.veiculoId);
  if(!v && !f.placa){ toast("Escolha a placa."); return; }
  if(!f.data){ toast("Informe a data do sinistro."); return; }
  if(!f.como.trim()){ toast("Descreva como aconteceu."); return; }
  const numero = f.numero || (Math.max(0, ...SIN.lista.map(x=>Number(x.numero)||0)) + 1);
  const reg = { numero, veiculo_id:v ? v.id : null, placa:v ? v.placa : f.placa, data:f.data, hora:f.hora||null, quem:f.quem.trim()||null, como:f.como.trim()||null, quando:f.quando.trim()||null,
    aonde:f.aonde.trim()||null, analise:f.analise.trim()||null, plano_acao:sinPlanoPreenchido(f.plano).map(x=>({ acao:x.acao.trim(), responsavel:x.responsavel.trim(), prazo:x.prazo })), anexos:f.anexos, anexos_qtd:f.anexos.length, atualizado_por:MEU_EMAIL, atualizado_em:new Date().toISOString() };
  let id = f.id;
  if(sb){ const gravar = (dados) => id ? sb.from("sinistros").update(dados).eq("id", id).select("id").single() : sb.from("sinistros").insert({ ...dados, criado_por:MEU_EMAIL }).select("id").single();
    let { data, error } = await gravar(reg);
    // banco ainda sem a coluna do plano de ação: salva o sinistro sem o plano e avisa
    if(error && /plano_acao/i.test(error.message)){ const { plano_acao, ...semPlano } = reg; ({ data, error } = await gravar(semPlano));
      if(!error) setTimeout(()=>toast("⚠ Sinistro salvo, mas SEM o plano de ação — falta rodar o SQL do plano de ação no Supabase."), 1600); }
    if(error){ toast(/sinistros/i.test(error.message) ? "⚠ Falta rodar o SQL do Sinistro no Supabase." : /too large|payload/i.test(error.message) ? "⚠ Anexos grandes demais — tire algum arquivo." : "⚠ Não salvou: " + error.message); return; } id = data.id; }
  else if(!id) id = osNovoId();
  const local = { id, numero, veiculoId:reg.veiculo_id, placa:reg.placa, data:reg.data, hora:reg.hora||"", quem:reg.quem||"", como:reg.como||"", quando:reg.quando||"", aonde:reg.aonde||"", analise:reg.analise||"", plano:sinPlanoNorm(reg.plano_acao),
    anexosQtd:f.anexos.length, anexos:f.anexos.map(a=>({ ...a })), por:f.por || (MEU_EMAIL||"").split("@")[0] };
  const k = SIN.lista.findIndex(x=>x.id===id); if(k>=0) SIN.lista[k] = local; else SIN.lista.unshift(local);
  sinSalvarLocal(); SIN_FORM = null; toast(`Sinistro nº ${sinNum(numero)} salvo ✓`); sinRedesenhar();
};
window.sinExcluir = async (id) => {
  const r = SIN.lista.find(x=>x.id===id); if(!r || !confirm(`Excluir o sinistro nº ${sinNum(r.numero)} (${r.placa})?`)) return;
  if(sb){ const { error } = await sb.from("sinistros").delete().eq("id", id); if(error){ toast("⚠ Não excluiu: " + error.message); return; } }
  SIN.lista = SIN.lista.filter(x=>x.id!==id); sinSalvarLocal(); sinRedesenhar();
};

/* ---------- Relatório do sinistro em PDF (para o WhatsApp) ---------- */
function sinDimImg(dados){ return new Promise(ok=>{ const i = new Image(); i.onload = () => ok({ w:i.width, h:i.height }); i.onerror = () => ok({ w:4, h:3 }); i.src = dados; }); }
async function sinPDFDoc(r){
  await nfgCarregarPDF();
  const an = await sinAnexos(r);
  const { jsPDF } = window.jspdf, doc = new jsPDF({ unit:"mm", format:"a4" }), W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 14;
  const v = SIN.veiculos.find(x=>x.id===r.veiculoId);
  doc.setFillColor(214, 40, 30); doc.rect(0, 0, W, 4, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.setTextColor(20, 20, 26); doc.text("AVANCE LOGÍSTICA INTEGRADA", M, 16);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(90, 90, 100); doc.text("Gestão de frota · registro de ocorrência", M, 22);
  doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(214, 40, 30); doc.text("RELATÓRIO DE SINISTRO", W-M, 13, { align:"right" });
  doc.setFontSize(20); doc.setTextColor(20, 20, 26); doc.text(`Nº ${sinNum(r.numero)}`, W-M, 21, { align:"right" });
  const caixas = [["Placa", r.placa||"-"], ["Frota nº", v ? String(v.ordem).padStart(2,"0") : "-"], ["Data", r.data ? fmtDataBR(r.data) : "-"], ["Hora", r.hora||"-"], ["Registrado por", r.por||"-"]];
  const bw = (W - 2*M - 12) / 5;
  caixas.forEach(([l, val], i)=>{ const x = M + i*(bw+3); doc.setFillColor(245, 245, 247); doc.roundedRect(x, 28, bw, 15, 2, 2, "F");
    doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(110, 110, 120); doc.text(l.toUpperCase(), x+3, 33);
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(20, 20, 26); doc.text(String(val), x+3, 40); });
  let y = 51;
  const quebra = (alt) => { if(y + alt > H - 16){ doc.addPage(); y = 18; } };
  [["QUEM?", r.quem], ["COMO?", r.como], ["QUANDO?", r.quando || `${r.data ? fmtDataBR(r.data) : ""}${r.hora ? " às " + r.hora : ""}`], ["AONDE?", r.aonde], ["ANÁLISE DA OCORRÊNCIA", r.analise]].forEach(([t, txt])=>{
    const linhas = doc.splitTextToSize(String(txt || "—"), W - 2*M - 6);
    quebra(10 + Math.min(linhas.length, 6) * 5);
    doc.setFillColor(20, 20, 26); doc.rect(M, y, W-2*M, 7, "F"); doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); doc.setTextColor(255, 255, 255); doc.text(t, M+3, y+5);
    y += 11; doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(20, 20, 26);
    linhas.forEach(l=>{ quebra(5); doc.text(l, M+3, y); y += 5; }); y += 4;
  });
  const pl = sinPlanoPreenchido(r.plano);
  quebra(24); doc.setFillColor(20, 20, 26); doc.rect(M, y, W-2*M, 7, "F"); doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); doc.setTextColor(255, 255, 255); doc.text("PLANO DE AÇÃO", M+3, y+5); y += 8;
  doc.autoTable({ startY:y, margin:{ left:M, right:M }, theme:"grid", head:[["#", "Ação", "Responsável", "Prazo"]],
    body:(pl.length ? pl : [{ acao:"—", responsavel:"", prazo:"" }]).map((x, i)=>[String(i+1), x.acao||"—", x.responsavel||"—", x.prazo ? fmtDataBR(x.prazo) : "—"]),
    styles:{ fontSize:9, cellPadding:2, textColor:[20,20,26], lineColor:[200,200,206], lineWidth:0.2, valign:"middle" }, headStyles:{ fillColor:[245,245,247], textColor:[20,20,26], fontStyle:"bold" },
    columnStyles:{ 0:{ cellWidth:9, halign:"center" }, 2:{ cellWidth:45 }, 3:{ cellWidth:26, halign:"center" } } });
  y = doc.lastAutoTable.finalY + 6;
  const fotos = an.filter(a=>/^image\//.test(a.tipo)), outros = an.filter(a=>!/^image\//.test(a.tipo));
  if(an.length){
    quebra(16); doc.setFillColor(214, 40, 30); doc.rect(M, y, W-2*M, 7, "F"); doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); doc.setTextColor(255, 255, 255);
    doc.text(`EVIDÊNCIAS (${an.length})`, M+3, y+5); y += 11;
    const cw = (W - 2*M - 6) / 2; let col = 0, linhaAlt = 0;
    for(const f of fotos){
      const d = f.w && f.h ? { w:f.w, h:f.h } : await sinDimImg(f.dados);
      const h = Math.min(cw * d.h / d.w, 95), w = h * d.w / d.h;
      if(col === 0){ quebra(h + 8); linhaAlt = 0; }
      const x = M + col*(cw+6) + (cw - w)/2;
      try{ doc.addImage(f.dados, "JPEG", x, y, w, h); }catch(e){}
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(110, 110, 120); doc.text(doc.splitTextToSize(f.nome, cw)[0], M + col*(cw+6), y + h + 4);
      linhaAlt = Math.max(linhaAlt, h + 8);
      if(col === 1){ y += linhaAlt; col = 0; } else col = 1;
    }
    if(col === 1) y += linhaAlt;
    if(outros.length){ quebra(8 + outros.length*5); doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(20, 20, 26); doc.text("Outros arquivos anexados ao registro:", M, y+3); y += 8;
      doc.setFont("helvetica", "normal"); outros.forEach(a=>{ doc.text(`• ${a.nome}`, M+3, y); y += 5; }); }
  }
  quebra(30); y += 14; doc.setDrawColor(150, 150, 160); doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(80, 80, 90);
  doc.line(M, y, M+80, y); doc.text("Responsável pelo registro", M, y+4.5); doc.line(W-M-80, y, W-M, y); doc.text("Gestor da frota / Diretoria", W-M-80, y+4.5);
  const np = doc.internal.getNumberOfPages();
  for(let i = 1; i <= np; i++){ doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(140, 140, 150); doc.text(`Sinistro nº ${sinNum(r.numero)} · ${r.placa} · gerado em ${fmtDataBR(frotaHojeISO())} às ${frotaHora()}`, M, H-7); doc.text(`Página ${i} de ${np}`, W-M, H-7, { align:"right" }); }
  return doc;
}
const sinNomePDF = (r) => `Sinistro_${sinNum(r.numero)}_${String(r.placa).replace(/[^A-Z0-9]+/gi,"")}.pdf`;
window.sinPDF = async (id) => { const r = SIN.lista.find(x=>x.id===id); if(!r) return; const aba = window.open("", "_blank");
  try{ const url = (await sinPDFDoc(r)).output("bloburl"); if(aba) aba.location.href = url; else (await sinPDFDoc(r)).save(sinNomePDF(r)); }catch(e){ if(aba) aba.close(); toast("⚠ Não foi possível gerar o PDF: " + e.message); } };
window.sinEnviar = async (id) => {
  const r = SIN.lista.find(x=>x.id===id); if(!r) return;
  let doc; try{ doc = await sinPDFDoc(r); }catch(e){ toast("⚠ Não foi possível gerar o PDF: " + e.message); return; }
  const nome = sinNomePDF(r), texto = `*Avance Logística Integrada*\nRelatório de sinistro nº ${sinNum(r.numero)}\nPlaca ${r.placa} · ${r.data ? fmtDataBR(r.data) : ""}${r.hora ? " às " + r.hora : ""}\nSegue o relatório em PDF.`;
  const arq = new File([doc.output("blob")], nome, { type:"application/pdf" });
  if(navigator.canShare && navigator.canShare({ files:[arq] })){ try{ await navigator.share({ files:[arq], title:`Sinistro ${sinNum(r.numero)}`, text:texto.replace(/\*/g,"") }); return; } catch(e){ if(e.name === "AbortError") return; } }
  doc.save(nome); window.open("https://wa.me/?text=" + encodeURIComponent(texto), "_blank"); toast("PDF baixado — no WhatsApp, anexe o arquivo " + nome);
};

function sinPagina(){
  sinGarantirCarga();
  if(SIN.erro) return `<div class="panel"><div class="empty-state" style="padding:24px;"><div class="glyph">⚠️</div><h4>Não foi possível carregar os sinistros</h4><p>${osEsc(SIN.erro)}</p><p>Se falar em tabela inexistente ("sinistros"), rode o SQL do Sinistro no Supabase.</p></div></div>`;
  if(!SIN.carregado) return `<div class="panel"><div class="empty-state" style="padding:24px;"><p>Carregando...</p></div></div>`;
  const f = SIN_FORM, ano = frotaHojeISO().slice(0,4), mes = frotaHojeISO().slice(0,7);
  const campo = (k, rotulo, dica, linhas) => `<label class="sin-q"><span>${rotulo}</span>${linhas ? `<textarea id="sin-${k}" rows="${linhas}" placeholder="${dica}">${osEsc(f[k]||"")}</textarea>` : `<input id="sin-${k}" value="${osEsc(f[k]||"")}" placeholder="${dica}">`}</label>`;
  return `
    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Sinistros no ano</div><div class="val">${SIN.lista.filter(r=>(r.data||"").startsWith(ano)).length}</div></div>
      <div class="kpi"><div class="lbl">No mês</div><div class="val">${SIN.lista.filter(r=>(r.data||"").startsWith(mes)).length}</div></div>
      <div class="kpi"><div class="lbl">Placas envolvidas</div><div class="val">${new Set(SIN.lista.map(r=>r.placa)).size}</div><div class="delta flat">de ${SIN.veiculos.length} na frota</div></div>
      <div class="kpi"><div class="lbl">Último registro</div><div class="val" style="font-size:22px;">${SIN.lista[0] ? `${osEsc(SIN.lista[0].placa)}` : "—"}</div><div class="delta flat">${SIN.lista[0] && SIN.lista[0].data ? fmtDataBR(SIN.lista[0].data) : ""}</div></div>
    </div>
    ${f ? `<div class="panel os-form sin-form" id="sin-form" style="margin-bottom:16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
        <h3 style="margin:0;">${f.id ? `✏️ Sinistro nº ${sinNum(f.numero)}` : "⚠️ Registrar sinistro"}</h3><button class="os-btn" onclick="sinCancelar()">Fechar</button>
      </div>
      <div class="nf-grid" style="grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); margin-top:10px;">
        <label>Placa<select id="sin-veiculoId" onchange="sinPlaca(this.value)"><option value="">Selecione</option>${SIN.veiculos.map(v=>`<option value="${v.id}" ${v.id===f.veiculoId?"selected":""}>${String(v.ordem).padStart(2,"0")} · ${osEsc(v.placa)}${v.motorista ? ` — ${osEsc(v.motorista)}` : ""}</option>`).join("")}</select></label>
        <label>Data<input type="date" id="sin-data" value="${f.data||""}"></label>
        <label>Hora<input type="time" id="sin-hora" value="${f.hora||""}"></label>
      </div>
      ${campo("quem", "Quem?", "motorista e demais envolvidos (terceiros, testemunhas)")}
      ${campo("como", "Como?", "o que aconteceu, passo a passo", 3)}
      ${campo("quando", "Quando?", "momento da ocorrência (ex: durante a manobra no pátio, na saída do turno)")}
      ${campo("aonde", "Aonde?", "local: endereço, pátio, cliente, rodovia/km")}
      ${campo("analise", "Análise da ocorrência?", "causa, responsabilidade, danos, medidas tomadas e próximos passos", 4)}
      <div class="sin-plano">
        <span class="sin-plano-tit">Plano de ação</span>
        <div class="sin-plano-grid"><b>#</b><b>Ação</b><b>Responsável</b><b>Prazo</b>
          ${(f.plano || sinPlanoVazio()).map((x, i)=>`<span class="sin-plano-n">${i+1}</span>
            <input id="sin-pa-acao-${i}" value="${osEsc(x.acao)}" placeholder="o que será feito">
            <input id="sin-pa-resp-${i}" value="${osEsc(x.responsavel)}" placeholder="quem faz">
            <input id="sin-pa-prazo-${i}" type="date" value="${x.prazo||""}">`).join("")}
        </div>
      </div>
      <div class="sin-anexos">
        <label class="sin-q" style="margin:0;"><span>Anexo de evidência (fotos ou arquivos)</span>
          <input type="file" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt" onchange="sinAddAnexos(this)"></label>
        ${f.anexos.length ? `<div class="sin-thumbs">${f.anexos.map((a,i)=>`<div class="sin-thumb">${/^image\//.test(a.tipo) ? `<img src="${a.dados}" alt="${osEsc(a.nome)}" onclick="sinVerAnexo(null, ${i})">` : `<div class="sin-arq" onclick="sinVerAnexo(null, ${i})">📎<span>${osEsc(a.nome)}</span></div>`}
          <button class="os-link" onclick="sinTirarAnexo(${i})" title="Tirar">🗑️</button></div>`).join("")}</div>` : `<div class="hint" style="margin:6px 0 0;">Fotos são reduzidas automaticamente; outros arquivos até 4 MB.</div>`}
      </div>
      <button class="entry-submit" onclick="sinSalvar()">💾 Salvar sinistro</button>
    </div>` : ""}
    <div class="panel" style="margin-bottom:16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
        <div><h3 style="margin:0;">⚠️ Sinistros registrados (${SIN.lista.length})</h3><div class="hint">Gere o relatório em PDF ou envie direto pelo WhatsApp.</div></div>
        <button class="entry-submit" style="margin:0;" onclick="sinNovo()">+ Registrar sinistro</button>
      </div>
      ${SIN.lista.length ? `<div style="overflow-x:auto; margin-top:10px;"><table class="nf-tab">
        <thead><tr><th>Nº</th><th>Data</th><th>Placa</th><th>Quem?</th><th>Como?</th><th>Aonde?</th><th>Anexos / plano</th><th></th></tr></thead>
        <tbody>${SIN.lista.map(r=>`<tr>
          <td><b>${sinNum(r.numero)}</b></td><td style="white-space:nowrap;">${r.data ? fmtDataBR(r.data) : "—"}${r.hora ? `<div class="hint" style="margin:0;">${r.hora}</div>` : ""}</td>
          <td><b>${osEsc(r.placa)}</b></td><td style="max-width:160px;">${osEsc(r.quem)||"—"}</td>
          <td style="max-width:280px; font-size:12.5px;">${osEsc((r.como||"").slice(0,140))}${(r.como||"").length > 140 ? "…" : ""}</td>
          <td style="max-width:180px; font-size:12.5px;">${osEsc(r.aonde)||"—"}</td>
          <td>${r.anexosQtd ? `📎 ${r.anexosQtd}` : "—"}${(()=>{ const pl = sinPlanoPreenchido(r.plano); if(!pl.length) return ""; const venc = pl.filter(x=>x.prazo && x.prazo < frotaHojeISO()).length;
            return `<div class="hint" style="margin:0; ${venc ? "color:var(--red); font-weight:700;" : ""}">${pl.length} ação(ões)${venc ? ` · ${venc} vencida(s)` : ""}</div>`; })()}</td>
          <td style="white-space:nowrap;"><button class="os-btn sm" onclick="sinPDF('${r.id}')">📄 PDF</button> <button class="os-btn sm green" onclick="sinEnviar('${r.id}')">📲 WhatsApp</button>
            <button class="os-link" onclick="sinEditar('${r.id}')" title="Editar">✏️</button> <button class="os-link" onclick="sinExcluir('${r.id}')" title="Excluir">🗑️</button></td>
        </tr>`).join("")}</tbody></table></div>` : `<div class="empty-state" style="padding:16px;"><p>Nenhum sinistro registrado.</p></div>`}
    </div>`;
}

// Infrações: aba SINISTRO no topo + a tela de infrações de sempre
renderers.infracoes = () => {
  const abas = `<div class="tabs" style="margin-bottom:14px;">
      <button class="tab-btn sin-tab ${INF_ABA==="sinistro"?"active":""}" onclick="setInfAba('sinistro')">⚠️ SINISTRO</button>
      <button class="tab-btn ${INF_ABA==="infracoes"?"active":""}" onclick="setInfAba('infracoes')">📊 Infrações</button>
    </div>`;
  if(INF_ABA === "sinistro") return abas + `<div class="page-head"><h2>Sinistro</h2><p>Registro de sinistros por placa — quem, como, quando, aonde e análise, com evidências e relatório em PDF</p></div>` + sinPagina();
  return abas + infracoesPagina();
};
initCharts.infracoes = () => { if(INF_ABA !== "sinistro") infracoesChartsBase(); };
/* -------------------- OPERAÇÃO BELÉM -------------------- */
renderers.belem = () => {
  const b = DATA.belem;
  const anosDisponiveis = [...new Set(b.lancamentos.map(r=>r.d).filter(Boolean).map(d=>d.slice(0,4)))].sort();
  const st = computarBelemStats(b.lancamentos, b.receita, FILTRO_BELEM.ano);
  const opt = (valor,label,atual) => `<option value="${valor}" ${atual===valor?"selected":""}>${label}</option>`;
  const vazio = b.lancamentos.length === 0 && Object.keys(b.receita).length === 0;

  const sinal = (v) => v >= 0 ? "green" : "red";
  const recentes = [...b.lancamentos].sort((a,c)=>c.d.localeCompare(a.d)).slice(0,25);
  const catLabel = Object.fromEntries(BELEM_CATEGORIAS.map(c=>[c.chave, c.label]));

  return `
    <div class="page-head">
      <h2>Operação Belém</h2>
      <p>Custos da operação e resultado mensal (DRE) — receita de contrato de ${fmtBRL(RECEITA_BELEM_PADRAO)}/mês${b.lancamentos.length ? ` · ${fmtNum(b.lancamentos.length)} lançamento(s)` : ""}</p>
      ${anosDisponiveis.length ? `
      <div class="tabs" style="margin-top:12px;">
        <button class="tab-btn ${FILTRO_BELEM.ano==="todos"?"active":""}" onclick="setFiltroBelem('ano','todos')">Todos</button>
        ${anosDisponiveis.map(a=>`<button class="tab-btn ${FILTRO_BELEM.ano===a?"active":""}" onclick="setFiltroBelem('ano','${a}')">${a}</button>`).join("")}
      </div>` : ""}
    </div>

    ${vazio ? `
    <div class="panel">
      <div class="empty-state" style="padding:24px;"><div class="glyph">🏗️</div>
        <h4>Nenhum dado de Belém ainda</h4>
        <p>Vá em <b>Entrada de Dados → Operação Belém</b> para importar as planilhas de combustível, mão de obra e peças.</p>
      </div>
    </div>` : `
    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Receita Bruta</div><div class="val">${fmtBRL(st.receitaTotal)}</div><div class="delta flat">${st.linhas.length} ${st.linhas.length===1?"mês":"meses"}</div></div>
      <div class="kpi"><div class="lbl">Custo Total</div><div class="val">${fmtBRL(st.custoTotal)}</div><div class="delta flat">${st.receitaTotal ? (st.custoTotal/st.receitaTotal*100).toFixed(1) : 0}% da receita</div></div>
      <div class="kpi"><div class="lbl">Resultado do Período</div><div class="val" style="color:var(--${sinal(st.resultadoTotal)});">${fmtBRL(st.resultadoTotal)}</div><div class="delta ${st.resultadoTotal>=0?"down":"up"}">${st.resultadoTotal>=0?"lucro":"prejuízo"}</div></div>
      <div class="kpi"><div class="lbl">Margem</div><div class="val" style="color:var(--${sinal(st.resultadoTotal)});">${st.margemTotal.toFixed(1)}%</div></div>
      ${st.porCategoria.map(c=>`
      <div class="kpi"><div class="lbl">${c.nome}</div><div class="val">${fmtBRL(c.valor)}</div><div class="delta flat">${st.custoTotal ? (c.valor/st.custoTotal*100).toFixed(1) : 0}% dos custos</div></div>`).join("")}
      ${st.linhas.length ? (() => {
        // Projeção anual: média mensal dos meses do DRE × 12
        const n = st.linhas.length;
        const receitaAno = st.receitaTotal / n * 12, custoAno = st.custoTotal / n * 12, resultadoAno = st.resultadoTotal / n * 12;
        return `
      <div class="kpi" title="Média dos ${n} ${n===1?"mês":"meses"} do DRE × 12 · Receita ${fmtBRL(receitaAno)} − Custo ${fmtBRL(custoAno)}"><div class="lbl">Projeção 12 meses (resultado)</div><div class="val" style="color:var(--${sinal(resultadoAno)});">${fmtBRL(resultadoAno)}</div><div class="delta flat">média de ${fmtBRL(st.resultadoTotal / n)}/mês · ${n} ${n===1?"mês":"meses"} base</div><div class="delta flat">Receita ${fmtBRL(receitaAno)} · Custo ${fmtBRL(custoAno)}</div></div>`;
      })() : ""}
    </div>

    <div class="panel" style="margin-bottom:16px;">
      <h3>DRE — Resultado mês a mês</h3>
      <div class="hint">A Receita Bruta começa em ${fmtBRL(RECEITA_BELEM_PADRAO)} (valor do contrato). Clique no valor para ajustar um mês específico — a alteração é salva na hora.</div>
      <table>
        <thead><tr>
          <th>Mês</th><th class="num">Receita Bruta</th><th class="num">Combustível</th><th class="num">Mão de Obra</th>
          <th class="num">Peças</th><th class="num">Custo Total</th><th class="num">Resultado</th><th class="num">Margem</th>
        </tr></thead>
        <tbody>
          ${st.linhas.map(l=>`<tr>
            <td><b>${l.label}</b></td>
            <td class="num"><input type="number" step="0.01" value="${l.receita}" onchange="salvarReceitaBelem('${l.mes}', this.value)"
                style="width:110px; text-align:right; font-family:inherit; font-size:12.5px; padding:4px 6px; border:1px solid var(--line); border-radius:6px; background:var(--paper);"></td>
            <td class="num">${fmtBRL2(l.combustivel)}</td>
            <td class="num">${fmtBRL2(l.mao_de_obra)}</td>
            <td class="num">${fmtBRL2(l.pecas)}</td>
            <td class="num"><b>${fmtBRL2(l.custoTotal)}</b></td>
            <td class="num" style="color:var(--${sinal(l.resultado)}); font-weight:700;">${fmtBRL2(l.resultado)}</td>
            <td class="num"><span class="badge ${l.resultado>=0?"green":"red"}">${l.margem.toFixed(1)}%</span></td>
          </tr>`).join("")}
        </tbody>
        <tfoot><tr style="font-weight:700; background:var(--paper);">
          <td>Total</td>
          <td class="num">${fmtBRL2(st.receitaTotal)}</td>
          ${BELEM_CATEGORIAS.map(c=>`<td class="num">${fmtBRL2(st.porCategoria.find(p=>p.nome===c.label).valor)}</td>`).join("")}
          <td class="num">${fmtBRL2(st.custoTotal)}</td>
          <td class="num" style="color:var(--${sinal(st.resultadoTotal)});">${fmtBRL2(st.resultadoTotal)}</td>
          <td class="num">${st.margemTotal.toFixed(1)}%</td>
        </tr></tfoot>
      </table>
    </div>

    <div class="panel" style="margin-bottom:16px;">
      <h3>Receita, Custo e Resultado por mês</h3>
      <div class="hint">Valores em R$ mil · embaixo do resultado, a margem do mês (resultado ÷ receita)</div>
      <div class="chart-wrap" style="height:320px;"><canvas id="ch-belem-dre"></canvas></div>
      <div class="chart-insight">${insightSerie(st.labels, st.linhas.map(l=>l.resultado), fmtBRL)}</div>
    </div>

    <div class="grid-2">
      <div class="panel">
        <h3>Custo por categoria (mensal)</h3>
        <div class="hint">Empilhado — combustível, mão de obra e peças</div>
        <div class="chart-wrap" style="height:280px;"><canvas id="ch-belem-cat"></canvas></div>
        <div class="chart-insight">${insightSerie(st.labels, st.linhas.map(l=>l.custoTotal), fmtBRL)}</div>
      </div>
      <div class="panel">
        <h3>Composição dos custos</h3>
        <div class="hint">% sobre o custo total do período</div>
        <div class="chart-wrap" style="height:280px;"><canvas id="ch-belem-comp"></canvas></div>
        <div class="chart-insight">${insightComposicao(st.porCategoria, "nome", "valor")}</div>
      </div>
    </div>

    <div class="panel">
      <h3>Lançamentos mais recentes</h3>
      <div class="hint">Últimos 25 registros importados</div>
      ${recentes.length === 0 ? `<div class="empty-state" style="padding:24px;"><div class="glyph">📋</div><p>Nenhum custo lançado ainda.</p></div>` : `
      <table>
        <thead><tr><th>Data</th><th>Categoria</th><th>Descrição</th><th>Referência</th><th class="num">Qtde</th><th class="num">Valor</th></tr></thead>
        <tbody>
          ${recentes.map(r=>`<tr>
            <td>${fmtDataBR(r.d)}</td>
            <td>${catLabel[r.categoria] || r.categoria}</td>
            <td>${r.descricao || "—"}</td>
            <td>${r.referencia || "—"}</td>
            <td class="num">${r.qtd != null ? fmtNum(r.qtd) : "—"}</td>
            <td class="num">${fmtBRL2(r.v)}</td>
          </tr>`).join("")}
        </tbody>
      </table>`}
    </div>
    `}
  `;
};

initCharts.belem = () => {
  const b = DATA.belem;
  const st = computarBelemStats(b.lancamentos, b.receita, FILTRO_BELEM.ano);
  if(!st.linhas.length) return;

  // Três barras por mês (Receita, Custo, Resultado) no mesmo eixo em R$, cada uma com o valor em cima;
  // a do Resultado leva também a margem. Resultado negativo (prejuízo) fica abaixo do zero, em vermelho escuro.
  const semRS = (v) => fmtLabelBRL(v).replace("R$ ","");
  const barra = { borderRadius:5, maxBarThickness:58, categoryPercentage:0.78, barPercentage:0.92 };
  const rotuloTopo = { display:true, anchor:"end", align:"end", offset:2, clamp:true, color:COLORS.ink, font:{ size:11.5, weight:800 } };
  mkChart("ch-belem-dre", {
    type:"bar",
    data:{ labels:st.labels, datasets:[
      { label:"Receita Bruta", data:st.linhas.map(l=>l.receita), backgroundColor:COLORS.green, ...barra,
        datalabels:{ ...rotuloTopo, formatter:semRS } },
      { label:"Custo Total", data:st.linhas.map(l=>l.custoTotal), backgroundColor:COLORS.red, ...barra,
        datalabels:{ ...rotuloTopo, formatter:semRS } },
      { label:"Resultado", data:st.linhas.map(l=>l.resultado), ...barra,
        backgroundColor:st.linhas.map(l=>l.resultado>=0 ? COLORS.ink : COLORS.redDark),
        datalabels:{ ...rotuloTopo,
          color:(c)=>st.linhas[c.dataIndex].resultado>=0 ? COLORS.ink : COLORS.redDark,
          formatter:(v,c)=>`${semRS(v)}\n${st.linhas[c.dataIndex].margem.toFixed(0)}%`, textAlign:"center" } },
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ position:"bottom", labels:{ boxWidth:12, usePointStyle:true, pointStyle:"rectRounded", padding:16,
          // a barra de Resultado muda de cor no prejuízo; a legenda mostra sempre a cor normal (preto)
          generateLabels:(chart)=>{ const it = Chart.defaults.plugins.legend.labels.generateLabels(chart); if(it[2]){ it[2].fillStyle = COLORS.ink; it[2].strokeStyle = COLORS.ink; } return it; } } },
        tooltip:{ mode:"index", intersect:false, callbacks:{
          label:(c)=>` ${c.dataset.label}: ${fmtBRL(c.raw)}`,
          afterBody:(its)=>{ const l = st.linhas[its[0].dataIndex]; return `Margem: ${l.margem.toFixed(1)}%`; } } } },
      layout:{ padding:{ top:34 } },
      scales:{ y:{ beginAtZero:true, grid:{ color:COLORS.grid }, border:{ display:false }, ticks:{ callback:v=>fmtMil(v), color:COLORS.inkSoft },
                   // com prejuízo, abre espaço abaixo do zero para o valor e a margem caberem
                   suggestedMin: Math.min(0, ...st.linhas.map(l=>l.resultado)) < 0 ? Math.min(...st.linhas.map(l=>l.resultado))*2.2 : 0 },
               x:{ grid:{ display:false }, border:{ display:false }, ticks:{ font:{ size:12, weight:700 }, color:COLORS.ink } } } }
  });

  mkChart("ch-belem-cat", {
    type:"bar",
    data:{ labels:st.labels, datasets: BELEM_CATEGORIAS.map(c=>({
      label:c.label, data:st.linhas.map(l=>l[c.chave]), backgroundColor:c.cor, stack:"a", borderRadius:3
    }))},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{position:"bottom", labels:{boxWidth:10, usePointStyle:true, pointStyle:"circle"}},
        datalabels:{ display:(ctx)=>ctx.dataset.data[ctx.dataIndex] > 3000, color:"#fff", font:{size:10, weight:700}, formatter:fmtLabelBRL } },
      scales:{ x:{stacked:true, grid:{display:false}}, y:{stacked:true, grid:{color:COLORS.grid}, ticks:{callback:v=>fmtMil(v)}} } }
  });

  const totalComp = sumArr(st.porCategoria.map(c=>c.valor));
  mkChart("ch-belem-comp", {
    type:"doughnut",
    data:{ labels:st.porCategoria.map(c=>c.nome), datasets:[{ data:st.porCategoria.map(c=>c.valor),
      backgroundColor:st.porCategoria.map(c=>c.cor), borderWidth:2, borderColor:"#fff" }]},
    options:{ responsive:true, maintainAspectRatio:false, cutout:"60%",
      plugins:{ legend:{position:"bottom", labels:{boxWidth:10, usePointStyle:true, pointStyle:"circle"}},
        datalabels:{ display:(ctx)=>totalComp>0 && ctx.dataset.data[ctx.dataIndex]/totalComp > 0.02, color:"#fff", font:{size:11, weight:700},
          formatter:(v)=> totalComp ? Math.round(v/totalComp*100)+"%" : "" } } }
  });
};

// Ajuste da receita bruta de um mês direto na tabela do DRE. Guarda só o mês alterado — os demais
// seguem no valor padrão de contrato.
window.salvarReceitaBelem = async (mes, valorTexto) => {
  const valor = parseFloat(valorTexto);
  if(isNaN(valor)){ toast("⚠ Valor de receita inválido"); return; }
  DATA.belem.receita[mes] = valor;
  navigate("belem");
  if(sb){
    const { error } = await sb.from("belem_receita").upsert({ mes, valor });
    if(error){ toast("⚠ Salvo aqui, mas falhou ao gravar no banco: " + error.message); return; }
  }
  toast(`Receita de ${rotuloMesBelem(mes)} ajustada para ${fmtBRL(valor)} ✓`);
};

/* -------------------- GESTÃO DE ACESSOS (só Diretor) -------------------- */
renderers.acessos = () => `
  <div class="page-head"><h2>Gestão de Acessos</h2><p>Libere ou altere o perfil de cada pessoa que já se cadastrou no site</p></div>
  <div class="panel">
    <div id="acessosArea"><div class="empty-state" style="padding:24px;"><div class="glyph">⏳</div><p>Carregando usuários...</p></div></div>
  </div>
`;
initCharts.acessos = () => { carregarGestaoAcessos(); };

async function carregarGestaoAcessos(){
  const area = document.getElementById("acessosArea");
  if(!area || !sb) return;
  const { data, error } = await sb.rpc("listar_usuarios_para_gestao");
  if(error){
    area.innerHTML = `<div class="empty-state" style="padding:24px;"><div class="glyph">⚠️</div><p>Não foi possível carregar a lista de usuários (${error.message}). Se o erro falar em função inexistente, confira se rodou o <code>supabase_user_roles.sql</code> no Supabase.</p></div>`;
    return;
  }
  if(!data.length){
    area.innerHTML = `<div class="empty-state" style="padding:24px;"><div class="glyph">👤</div><p>Ninguém se cadastrou ainda.</p></div>`;
    return;
  }
  area.innerHTML = `
    <table>
      <thead><tr><th>E-mail</th><th>Cadastro</th><th>Perfil</th><th></th></tr></thead>
      <tbody>
        ${data.map(u=>`<tr>
          <td>${u.email}</td>
          <td>${fmtDataBR(u.criado_em.slice(0,10))}</td>
          <td>
            <select id="papel-${u.user_id}">
              <option value="sem_perfil" ${u.papel==="sem_perfil"?"selected":""}>Sem perfil (aguardando)</option>
              <option value="operacional" ${u.papel==="operacional"?"selected":""}>Operacional</option>
              <option value="lider" ${u.papel==="lider"?"selected":""}>Líder (só Status da Frota)</option>
              <option value="monitoramento" ${u.papel==="monitoramento"?"selected":""}>Monitoramento (só Programação de Entregas)</option>
              <option value="coordenacao" ${u.papel==="coordenacao"?"selected":""}>Coordenação (só Emissão de NF)</option>
${u.papel==="manutencao" ? `<option value="manutencao" selected>Manutenção (tela desativada)</option>` : ""}
              <option value="rh" ${u.papel==="rh"?"selected":""}>RH (só Organograma)</option>
              <option value="administrativo" ${u.papel==="administrativo"?"selected":""}>Administrativo (Emissão de O.S + Organograma)</option>
              <option value="preos" ${u.papel==="preos"?"selected":""}>Operação (só Pré O.S / plano do dia)</option>
              <option value="frotaoficina" ${u.papel==="frotaoficina"?"selected":""}>Oficina da frota (só aba Oficina do Status da Frota)</option>
              <option value="oficina" ${u.papel==="oficina"?"selected":""}>Oficina (só Controle de carretas)</option>
              <option value="diretor" ${u.papel==="diretor"?"selected":""}>Diretor</option>
            </select>
          </td>
          <td><button onclick="salvarPapelUsuario('${u.user_id}','${u.email}')" style="background:var(--red); color:#fff; border:none; padding:6px 12px; border-radius:6px; font-size:11.5px; font-weight:700; cursor:pointer;">Salvar</button></td>
        </tr>`).join("")}
      </tbody>
    </table>
  `;
}

window.salvarPapelUsuario = async (userId, email) => {
  const sel = document.getElementById(`papel-${userId}`);
  const papel = sel.value;
  if(papel === "sem_perfil"){
    const { error } = await sb.from("user_roles").delete().eq("user_id", userId);
    if(error){ toast("⚠ Falha ao remover acesso: " + error.message); return; }
    toast(`Acesso de ${email} removido`);
  } else {
    const { error } = await sb.from("user_roles").upsert({ user_id:userId, email, papel });
    if(error){ toast("⚠ Falha ao salvar: " + error.message); return; }
    toast(`${email} agora é ${({ diretor:"Diretor", operacional:"Operacional", lider:"Líder (só Status da Frota)", monitoramento:"Monitoramento (só Programação de Entregas)", coordenacao:"Coordenação (só Emissão de NF)", manutencao:"Manutenção (só O.S de Manutenção)", rh:"RH (só Organograma)", oficina:"Oficina (só Controle de carretas)" })[papel]} ✓`);
  }
  carregarGestaoAcessos();
};

(async function initAuth(){
  if(!sb){
    document.body.classList.add("authed");
    iniciarPainel();
    return;
  }
  const aplicarSessao = async (session) => {
    if(!session){
      document.body.classList.remove("authed","pending");
      painelIniciado = false;
      MEU_PAPEL = null;
      return;
    }
    // Descobre o perfil (Diretor/Operacional) atribuído a essa pessoa — se ainda não tiver nenhum,
    // fica na tela de "aguardando liberação" em vez de entrar direto no painel (cadastro é aberto,
    // mas o ACESSO às telas depende de um Diretor liberar depois).
    const { data: roleRow } = await sb.from("user_roles").select("papel").eq("user_id", session.user.id).maybeSingle();
    if(!roleRow){
      document.body.classList.remove("authed");
      document.body.classList.add("pending");
      document.getElementById("pendingUserEmail").textContent = session.user.email;
      painelIniciado = false;
      MEU_PAPEL = null;
      return;
    }
    MEU_PAPEL = roleRow.papel;
    MEU_EMAIL = session.user.email || "";
    document.body.classList.remove("pending");
    document.body.classList.add("authed");
    document.getElementById("authUserEmail").textContent = session.user.email;
    aplicarRestricoesDePapel();
    if(!painelIniciado){ painelIniciado = true; iniciarPainel(); }
  };
  const { data:{ session } } = await sb.auth.getSession();
  await aplicarSessao(session);
  sb.auth.onAuthStateChange((_event, session) => aplicarSessao(session));
})();
