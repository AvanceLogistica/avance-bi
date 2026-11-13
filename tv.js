/* ============================================================================
   AVANCE · PAINEL TV (Control Tower) — tela independente para a smart TV.
   Lê direto do Supabase (mesmo login do sistema) e atualiza a cada minuto:
   - Frota: frota_veiculos + frota_status (status do dia) + frota_oficina (paradas abertas)
   - Entregas: entregas_programacao (meta fixa de 10 por dia, segunda a sexta)
   - Balsas: balsa_operacoes (descarga / carregamento, viagens por pier Panamá e Luiza)
   - Carretas do cliente na fila: carretas_fila
   ============================================================================ */
const TV_META_ENTREGAS = 10;            // meta de segunda a sexta
const TV_HORA_INI = 7, TV_HORA_FIM = 17; // janela da meta acumulada (07h → 17h)
const TV_DIAS_ALERTA = 3;               // parado há mais de 3 dias = alerta
const TV_ATUALIZA_MS = 60000;
// atividades do Status da Frota (mesmas cores do sistema)
const ATIVIDADES = [ { k:"honda", t:"Operação Honda", c:"#E3172F" }, { k:"reserva", t:"Disponível", c:"#8A94A3" }, { k:"entregas", t:"Entregas e Coletas", c:"#3B82F6" },
  { k:"manobra", t:"Manobra Pátio Externo", c:"#A855F7" }, { k:"porto", t:"Porto", c:"#22C55E" }, { k:"oficina", t:"Oficina", c:"#F5B921" } ];
const PIERS = [ { k:"panama", nome:"Panamá" }, { k:"luiza", nome:"Luiza" } ];
const COR = { verde:"#22C55E", azul:"#3B82F6", ciano:"#22D3EE", ambar:"#F5B921", vermelho:"#E3172F", laranja:"#F2711C", cinza:"#62708A", ink:"#F2F5FA", soft:"#9AA8BE", grade:"rgba(120,160,220,.12)" };
const SEM = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];
const MES = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];

const sbTv = (typeof supabase !== "undefined" && typeof SUPABASE_URL !== "undefined" && SUPABASE_URL) ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const hojeISO = () => iso(new Date());
const somaDias = (s, n) => { const d = new Date(s+"T12:00:00"); d.setDate(d.getDate()+n); return iso(d); };
const diasEntre = (a, b) => Math.round((new Date(b+"T12:00:00") - new Date(a+"T12:00:00")) / 864e5);
const minutos = (h) => { const m = String(h||"").match(/(\d{1,2}):(\d{2})/); return m ? (+m[1])*60 + (+m[2]) : null; };
const ehDiaUtil = (s) => { const w = new Date(s+"T12:00:00").getDay(); return w>=1 && w<=5; };
const charts = {};

if(typeof Chart !== "undefined"){
  if(typeof ChartDataLabels !== "undefined"){ Chart.register(ChartDataLabels); Chart.defaults.plugins.datalabels.display = false; }
  Chart.defaults.color = COR.soft;
  Chart.defaults.font.family = '"Segoe UI", Inter, system-ui, sans-serif';
  Chart.defaults.animation.duration = 700;
}
const fs = (rem) => parseFloat(getComputedStyle(document.documentElement).fontSize) * rem;
function grafico(id, cfg){
  const el = $(id); if(!el || typeof Chart === "undefined") return;
  if(charts[id]){ charts[id].data = cfg.data; charts[id].options = cfg.options; charts[id].update(); return; }
  charts[id] = new Chart(el.getContext("2d"), cfg);
}

/* ---------------- relógio ---------------- */
function relogio(){
  const d = new Date();
  $("tv-hora").textContent = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  $("tv-data").textContent = `📅 ${SEM[d.getDay()]}, ${d.getDate()} ${MES[d.getMonth()]} ${d.getFullYear()}`;
}
setInterval(relogio, 1000); relogio();

/* ---------------- login ---------------- */
window.tvEntrar = async (ev) => {
  ev.preventDefault();
  const btn = $("lg-btn"), err = $("lg-err"); err.textContent = ""; btn.disabled = true; btn.textContent = "Entrando...";
  const { error } = await sbTv.auth.signInWithPassword({ email:$("lg-email").value.trim(), password:$("lg-senha").value });
  btn.disabled = false; btn.textContent = "Entrar";
  if(error){ err.textContent = /invalid login/i.test(error.message) ? "E-mail ou senha incorretos." : error.message; return; }
  $("login").classList.remove("on"); atualizar();
};

/* ---------------- busca no banco ---------------- */
async function buscar(){
  const hoje = hojeISO(), desde45 = somaDias(hoje, -45), desde13 = somaDias(hoje, -13), iniMes = hoje.slice(0,8) + "01";
  const desdeProg = iniMes < desde13 ? iniMes : desde13;
  const q = (p) => p.then(r=>r, e=>({ error:{ message:String(e) } }));
  const [veic, st, of, prog, bal, fila, os] = await Promise.all([
    q(sbTv.from("frota_veiculos").select("id,ordem,placa,motorista,atividade_padrao,obs").order("ordem")),
    q(sbTv.from("frota_status").select("data,veiculo_id,atividade,status,motorista,obs").gte("data", desde45).lte("data", hoje)),
    q(sbTv.from("frota_oficina").select("veiculo_id,placa,data_parada,observacao,aprovacao,inicio_execucao,conclusao").is("conclusao", null)),
    q(sbTv.from("entregas_programacao").select("data,situacao,horario,hora_real,servico,frota,cliente,planejado").gte("data", desdeProg).lte("data", hoje)),
    q(sbTv.from("balsa_operacoes").select("data,pier,balsa,tipo,viagens,hora_inicio,hora_fim").gte("data", desde13).lte("data", hoje)),
    q(sbTv.from("carretas_fila").select("frota,placa,data_entrada").is("data_conclusao", null)),
    q(sbTv.from("manutencao_os").select("status,saida_data,frota").gte("saida_data", iniMes).lte("saida_data", hoje)),
  ]);
  const erros = [["Frota", veic], ["Status da frota", st], ["Oficina", of], ["Entregas", prog], ["Balsas", bal], ["Carretas", fila], ["O.S de carretas", os]].filter(([,r])=>r.error).map(([n,r])=>`${n}: ${r.error.message}`);
  let email = ""; try{ email = (await sbTv.auth.getUser()).data.user?.email || ""; }catch(e){}
  return { hoje, agora:new Date(), erros, email,
    veiculos: veic.data||[], status: st.data||[], oficina: of.data||[], programacao: prog.data||[], balsas: bal.data||[], fila: fila.data||[], os: (os.data||[]).filter(o=>(o.status||"emitida")==="emitida"),
    semAcesso:{ os:!!os.error, frota:!!veic.error, entregas:!!prog.error, balsas:!!bal.error } };
}

/* ---------------- cálculos ---------------- */
function calcular(D){
  const hoje = D.hoje, agora = D.agora, minAgora = agora.getHours()*60 + agora.getMinutes();
  // status do dia de cada veículo: lançamento de hoje ou o último anterior (igual ao Status da Frota)
  const porVeic = {}; D.status.forEach(r=>{ (porVeic[r.veiculo_id] = porVeic[r.veiculo_id] || []).push(r); });
  Object.values(porVeic).forEach(ls=>ls.sort((a,b)=>a.data.localeCompare(b.data)));
  const naOficina = (r) => r.status === "manutencao" || r.atividade === "oficina";
  const frota = D.veiculos.map(v=>{
    const ls = porVeic[v.id] || [], r = [...ls].reverse().find(x=>x.data<=hoje)
      || { atividade:v.atividade_padrao||"reserva", status:(v.atividade_padrao==="oficina" ? "manutencao" : "operando"), obs:v.obs||"", data:null };
    let desde = null;
    if(naOficina(r)){
      const of = D.oficina.find(o=>o.veiculo_id===v.id) || D.oficina.find(o=>o.placa && v.placa && o.placa.replace(/\W/g,"").toUpperCase()===v.placa.replace(/\W/g,"").toUpperCase());
      if(of) desde = of.data_parada;
      else { // começo da sequência de dias "em manutenção" lançados
        for(let i=ls.length-1; i>=0; i--){ if(ls[i].data>hoje) continue; if(naOficina(ls[i])) desde = ls[i].data; else break; }
      }
      return { v, r, of, desde, dias: desde ? Math.max(0, diasEntre(desde, hoje)) : null };
    }
    return { v, r };
  });
  const total = frota.length;
  const man = frota.filter(f=>naOficina(f.r)), parado = frota.filter(f=>!naOficina(f.r) && f.r.status==="parado"), semMot = frota.filter(f=>!naOficina(f.r) && f.r.status==="semmot");
  const operando = total - man.length - parado.length - semMot.length;
  const dispPct = total ? Math.round((total - man.length - parado.length)/total*100) : 0;
  const ofStatus = (f) => !f.of ? { t:"Em manutenção", c:COR.ambar } : f.of.aprovacao==="reprovado" ? { t:"Reprovado", c:COR.vermelho }
    : !f.of.aprovacao ? { t:"Aguard. aprovação", c:COR.laranja } : f.of.inicio_execucao ? { t:"Em execução", c:COR.azul } : { t:"Aprovado", c:COR.verde };
  man.forEach(f=>{ f.st = ofStatus(f); });
  man.sort((a,b)=>(b.dias??-1)-(a.dias??-1));

  // entregas
  const progHoje = D.programacao.filter(r=>r.data===hoje);
  const realizadas = progHoje.filter(r=>r.situacao==="realizada");
  const meta = ehDiaUtil(hoje) ? TV_META_ENTREGAS : 0;
  const fracDia = Math.min(1, Math.max(0, (minAgora - TV_HORA_INI*60) / ((TV_HORA_FIM-TV_HORA_INI)*60)));
  const esperado = meta * fracDia;
  const atrasadas = progHoje.filter(r=>r.situacao==="pendente" && minutos(r.horario)!=null && minutos(r.horario) + 60 < minAgora);
  const horas = []; for(let h=TV_HORA_INI; h<=TV_HORA_FIM+1; h++) horas.push(h);
  const semHora = realizadas.filter(r=>minutos(r.hora_real)==null).length;
  const evoReal = horas.map(h=> h*60 > minAgora + 59 ? null : realizadas.filter(r=>{ const m = minutos(r.hora_real); return m==null ? false : m < (h+1)*60; }).length);
  // entregas marcadas sem horário entram no ponto atual
  if(semHora){ let ult = -1; evoReal.forEach((v,i)=>{ if(v!=null) ult = i; }); if(ult>=0) evoReal[ult] += semHora; }
  const evoMeta = horas.map(h=> meta ? Math.min(meta, Math.max(0, meta*((h+1-TV_HORA_INI)/(TV_HORA_FIM-TV_HORA_INI+1)))) : null);

  // balsas
  const balHoje = D.balsas.filter(r=>r.data===hoje);
  const sv = (ls, f) => ls.filter(f).reduce((s,r)=>s+(Number(r.viagens)||0), 0);
  const desc = sv(balHoje, r=>r.tipo==="descarga"), carr = sv(balHoje, r=>r.tipo==="carregamento");

  // mês corrente, dia a dia até hoje: entregas planejado × realizado e carretas (O.S emitidas pela data de saída)
  const diasMes = []; for(let d = hoje.slice(0,8) + "01"; d <= hoje; d = somaDias(d, 1)) diasMes.push(d);
  const progMes = D.programacao.filter(r=>r.data.slice(0,7)===hoje.slice(0,7));
  const planReal = diasMes.map(d=>{ const ls = progMes.filter(r=>r.data===d); return { d, plan:ls.filter(r=>r.planejado!==false).length, real:ls.filter(r=>r.situacao==="realizada").length }; });
  const planMes = planReal.reduce((s,x)=>s+x.plan,0), realMes = planReal.reduce((s,x)=>s+x.real,0);
  const realPlanMes = progMes.filter(r=>r.planejado!==false && r.situacao==="realizada").length;
  const carDia = diasMes.map(d=>({ d, n:(D.os||[]).filter(o=>o.saida_data===d).length }));
  const carHoje = (D.os||[]).filter(o=>o.saida_data===hoje).length, carMes = (D.os||[]).length;
  // frota por atividade (Status da Frota)
  const porAtiv = ATIVIDADES.map(a=>({ ...a, n:frota.filter(f=>(f.r.atividade||"reserva")===a.k).length }));

  // saúde: entregas no ritmo do horário (dia útil) + frota disponível
  const ritmo = esperado >= 1 ? Math.min(100, realizadas.length/esperado*100) : null;
  const partes = [dispPct, ...(ritmo!=null ? [ritmo] : [])];
  const saude = total ? Math.round(partes.reduce((s,x)=>s+x,0)/partes.length) : null;

  return { hoje, minAgora, frota, total, man, parado, semMot, operando, dispPct, progHoje, realizadas, meta, esperado, atrasadas,
    horas, evoReal, evoMeta, balHoje, desc, carr, planReal, planMes, realMes, realPlanMes, carDia, carHoje, carMes, porAtiv, ritmo, saude, fila:D.fila, D };
}

/* ---------------- desenho ---------------- */
let OF_PAG = 0;
function renderizar(D){
  const C = calcular(D);
  const nf = (n) => n==null ? "—" : String(n).padStart(2,"0");

  // KPIs
  $("k-car-dia").textContent = D.semAcesso.os ? "—" : nf(C.carHoje);
  $("k-car-mes").textContent = D.semAcesso.os ? "—" : nf(C.carMes);
  $("k-car-mes-sub").textContent = `em ${MES[Number(C.hoje.slice(5,7))-1].toLowerCase()}/${C.hoje.slice(2,4)}`;
  $("k-ent").textContent = D.semAcesso.entregas ? "—" : nf(C.realizadas.length);
  $("k-ent-pct").textContent = C.meta ? `${Math.round(C.realizadas.length/C.meta*100)}%` : "—";
  $("k-ent-pct").style.color = !C.meta ? COR.soft : C.realizadas.length >= C.meta ? COR.verde : C.realizadas.length + 0.5 >= C.esperado ? COR.verde : COR.ambar;
  $("k-ent-sub").innerHTML = C.meta ? `da meta<br>(${C.meta} viagens)` : "fim de semana<br>(sem meta)";
  $("k-desc").textContent = D.semAcesso.balsas ? "—" : nf(C.desc);
  $("k-carr").textContent = D.semAcesso.balsas ? "—" : nf(C.carr);

  // saúde (meia-lua)
  const s = C.saude, corS = s==null ? COR.cinza : s>=85 ? COR.verde : s>=70 ? COR.ambar : COR.vermelho;
  $("k-saude").textContent = s==null ? "—" : `${s}%`;
  const selo = $("k-saude-selo"); selo.textContent = s==null ? "sem dados" : s>=85 ? "Bom desempenho" : s>=70 ? "Atenção" : "Crítico";
  selo.style.background = corS; selo.style.color = s!=null && s>=70 && s<85 ? "#1A1300" : "#fff";
  $("k-saude-sub").textContent = C.ritmo!=null ? `frota disponível ${C.dispPct}% · entregas no ritmo ${Math.round(C.ritmo)}%` : `frota disponível ${C.dispPct}%`;
  grafico("ch-gauge", { type:"doughnut", data:{ datasets:[{ data:[s||0, 100-(s||0)], backgroundColor:[corS, "rgba(255,255,255,.08)"], borderWidth:0, borderRadius:[fs(.6), 0] }] },
    options:{ responsive:true, maintainAspectRatio:false, rotation:-90, circumference:180, cutout:"74%", plugins:{ legend:{ display:false }, tooltip:{ enabled:false } } } });

  // disponibilidade
  const itens = C.porAtiv.map(a=>({ t:a.t, n:a.n, c:a.c }));
  $("disp-pct").textContent = C.total ? nf(C.total) : "—";
  $("disp-sub").textContent = C.total ? `disponibilidade ${C.dispPct}%` : (D.semAcesso.frota ? "sem acesso" : "");
  $("disp-lista").innerHTML = itens.map(i=>`<li><i style="background:${i.c}"></i><b>${nf(i.n)}</b>${i.t}</li>`).join("") + `<li><i style="background:transparent; border:2px solid ${COR.soft}"></i><b>${nf(C.total)}</b>Total</li>`;
  grafico("ch-disp", { type:"doughnut", data:{ labels:itens.map(i=>i.t), datasets:[{ data:itens.map(i=>i.n), backgroundColor:itens.map(i=>i.c), borderColor:"#0E1829", borderWidth:3 }] },
    options:{ responsive:true, maintainAspectRatio:false, cutout:"72%", plugins:{ legend:{ display:false }, tooltip:{ enabled:false } } } });

  // oficina
  const cont = {}; C.man.forEach(f=>{ const k = f.st.t; cont[k] = cont[k] || { n:0, c:f.st.c }; cont[k].n++; });
  const criticos = C.man.filter(f=>f.dias!=null && f.dias > TV_DIAS_ALERTA);
  $("of-sub").textContent = C.man.length ? `${C.man.length} veículo(s)${criticos.length ? ` · ${criticos.length} há + de ${TV_DIAS_ALERTA} dias` : ""}` : "";
  $("of-chips").innerHTML = Object.entries(cont).map(([t,o])=>`<div class="of-chip"><i style="background:${o.c}"></i><b>${o.n}</b>${t}</div>`).join("");
  desenharOficina(C);

  // entregas: planejado (barra cinza larga) × realizado (barra vermelha por dentro), dia a dia no mês
  const PR = C.planReal, SEMc = ["D","S","T","Q","Q","S","S"];
  $("plan-plan").textContent = nf(C.planMes); $("plan-real").textContent = nf(C.realMes);
  $("plan-pct").textContent = C.planMes ? `${Math.round(C.realPlanMes/C.planMes*100)}%` : "—";
  $("plan-mes").textContent = `${MES[Number(C.hoje.slice(5,7))-1]}/${C.hoje.slice(0,4)}`;
  const corPR = (x) => !x.plan ? COR.soft : x.real >= x.plan ? COR.verde : "#FF5A6A";
  grafico("ch-plan", { type:"bar", data:{ labels:PR.map(x=>x.d.slice(8,10)), datasets:[
      { label:"Planejado", data:PR.map(x=>x.plan), backgroundColor:"rgba(213,215,223,.28)", borderRadius:4, grouped:false, order:2, barPercentage:.9, categoryPercentage:.9,
        datalabels:{ display:(c)=>{ const x = PR[c.dataIndex]; return !!(x.plan||x.real); }, formatter:(_v,c)=>{ const x = PR[c.dataIndex]; return `${x.real}/${x.plan}`; },
          color:(c)=>corPR(PR[c.dataIndex]), anchor:(c)=>"end", align:"top", offset:1, clamp:true, font:{ size:fs(.85), weight:800 } } },
      { label:"Realizado", data:PR.map(x=>x.real), backgroundColor:COR.vermelho, borderRadius:3, grouped:false, order:1, barPercentage:.5, categoryPercentage:.9 } ] },
    options:{ responsive:true, maintainAspectRatio:false, layout:{ padding:{ top:fs(1.4) } },
      plugins:{ legend:{ position:"top", align:"end", labels:{ boxWidth:fs(1), font:{ size:fs(1) }, color:COR.soft } }, tooltip:{ enabled:false } },
      scales:{ x:{ grid:{ display:false }, ticks:{ autoSkip:false, maxRotation:0, font:(c)=>({ size:fs(.8), weight: PR[c.index]?.d===C.hoje ? 900 : 500 }), color:(c)=>PR[c.index]?.d===C.hoje ? COR.ink : COR.soft } },
        y:{ beginAtZero:true, suggestedMax:Math.max(4, ...PR.map(x=>Math.max(x.plan,x.real)))*1.2, grid:{ color:COR.grade }, border:{ display:false }, ticks:{ precision:0, font:{ size:fs(.9) } } } } } });

  // carretas por dia (O.S emitidas pela data de saída)
  const CD = C.carDia;
  $("carr-sub").textContent = `${C.carMes} no mês`;
  grafico("ch-carretas", { type:"bar", data:{ labels:CD.map(x=>x.d.slice(8,10)), datasets:[
      { label:"Carretas", data:CD.map(x=>x.n), backgroundColor:CD.map(x=>x.d===C.hoje ? COR.laranja : "#C9D1DE"), borderRadius:4, maxBarThickness:fs(2.6),
        datalabels:{ display:(c)=>c.dataset.data[c.dataIndex] > 0, anchor:"end", align:"top", offset:1, color:COR.ink, font:{ size:fs(.95), weight:800 } } } ] },
    options:{ responsive:true, maintainAspectRatio:false, layout:{ padding:{ top:fs(1.4) } },
      plugins:{ legend:{ display:false }, tooltip:{ enabled:false } },
      scales:{ x:{ grid:{ display:false }, ticks:{ autoSkip:false, maxRotation:0, font:{ size:fs(.8) } } },
        y:{ beginAtZero:true, suggestedMax:Math.max(4, ...CD.map(x=>x.n))*1.2, grid:{ color:COR.grade }, border:{ display:false }, ticks:{ precision:0, font:{ size:fs(.9) } } } } } });

  // balsas por pier
  const porPier = PIERS.map(p=>({ p, desc:C.balHoje.filter(r=>r.pier===p.k && r.tipo==="descarga").reduce((s,r)=>s+(+r.viagens||0),0), carr:C.balHoje.filter(r=>r.pier===p.k && r.tipo==="carregamento").reduce((s,r)=>s+(+r.viagens||0),0) }));
  $("bal-tot").textContent = D.semAcesso.balsas ? "—" : nf(C.desc + C.carr);
  const lb = { display:(c)=>c.dataset.data[c.dataIndex] > 0, anchor:"end", align:"top", offset:2, color:"#fff", font:{ size:fs(1.25), weight:900 } };
  grafico("ch-bal", { type:"bar", data:{ labels:PIERS.map(p=>`Pier ${p.nome}`), datasets:[
      { label:"Descarga", data:porPier.map(x=>x.desc), backgroundColor:COR.verde, borderRadius:6, maxBarThickness:fs(4), datalabels:lb },
      { label:"Carregamento", data:porPier.map(x=>x.carr), backgroundColor:COR.ciano, borderRadius:6, maxBarThickness:fs(4), datalabels:lb } ] },
    options:{ responsive:true, maintainAspectRatio:false, layout:{ padding:{ top:fs(1.6) } },
      plugins:{ legend:{ position:"top", labels:{ boxWidth:fs(1), font:{ size:fs(1) }, color:COR.soft } }, tooltip:{ enabled:false } },
      scales:{ x:{ grid:{ display:false }, ticks:{ font:{ size:fs(1.1), weight:700 }, color:COR.ink } }, y:{ beginAtZero:true, suggestedMax:Math.max(4, ...porPier.flatMap(x=>[x.desc,x.carr]))*1.3, grid:{ color:COR.grade }, border:{ display:false }, ticks:{ precision:0, font:{ size:fs(.95) } } } } } });
  const balsasDia = {}; C.balHoje.forEach(r=>{ const k = r.balsa||"—"; balsasDia[k] = balsasDia[k] || []; balsasDia[k].push(`${r.tipo==="descarga" ? "⬇" : "⬆"}${r.viagens}`); });
  $("bal-lista").innerHTML = Object.keys(balsasDia).length ? "Balsas: " + Object.entries(balsasDia).map(([b,t])=>`<b>${esc(b)}</b> ${t.join(" ")}`).join(" · ") : (D.semAcesso.balsas ? "Sem acesso às operações de balsa" : "Nenhuma operação de balsa lançada hoje");

  // realizado x meta
  const linhaRM = (ic, t, a, b, sufixo) => { const p = b ? Math.round(a/b*100) : null; const cor = p==null ? COR.soft : p>=90 ? COR.verde : p>=70 ? COR.ambar : COR.vermelho;
    return `<div class="rm-i"><div class="ic">${ic}</div><div><div class="t">${t}<span>${a} / ${b||"—"}${sufixo||""}</span></div><div class="bar"><i style="width:${p==null?0:Math.min(100,p)}%; background:linear-gradient(90deg, ${cor}, ${cor}cc);"></i></div></div><div class="p" style="color:${cor}">${p==null?"—":p+"%"}</div></div>`; };
  $("rm").innerHTML = [
    linhaRM("🚚", "Meta do dia", C.realizadas.length, C.meta),
    linhaRM("📋", "Programadas", C.realizadas.length, C.progHoje.length),
    linhaRM("⏱️", "Ritmo", C.realizadas.length, C.esperado >= 1 ? Math.round(C.esperado) : 0),
    linhaRM("🚛", "Frota disp.", C.total - C.man.length - C.parado.length, C.total),
  ].join("");

  // alertas
  const al = [];
  if(criticos.length) al.push({ ic:"🚛", h:`<b>${criticos.length}</b> veículo(s) parado(s) há + de ${TV_DIAS_ALERTA} dias: ${criticos.slice(0,3).map(f=>esc(f.v.placa)).join(", ")}${criticos.length>3?"…":""}` });
  if(C.atrasadas.length) al.push({ ic:"⏰", h:`<b>${C.atrasadas.length}</b> entrega(s) programada(s) atrasada(s) (passou + de 1h do horário)` });
  if(C.meta && C.esperado >= 2 && C.realizadas.length < C.esperado - 1) al.push({ ic:"🎯", h:`Entregas abaixo do ritmo: <b>${C.realizadas.length}</b> de ${Math.round(C.esperado)} esperadas até agora` });
  if(C.parado.length) al.push({ ic:"⛔", h:`<b>${C.parado.length}</b> veículo(s) com status Parado` });
  if(C.semMot.length) al.push({ ic:"👤", h:`<b>${C.semMot.length}</b> veículo(s) sem motorista hoje`, cls:"info" });
  if(!D.semAcesso.balsas && !C.balHoje.length && C.minAgora >= 10*60) al.push({ ic:"🚢", h:`<b>Nenhuma</b> operação de balsa lançada hoje`, cls:"info" });
  if(C.fila.length) al.push({ ic:"🔩", h:`<b>${C.fila.length}</b> carreta(s) do cliente na fila de manutenção`, cls:"info" });
  if(!D.veiculos.length && !D.semAcesso.frota) al.unshift({ ic:"🔒", h:`<b>Sem permissão para ver os dados.</b> O usuário ${esc(D.email||"")} precisa do perfil <b>TV</b> (Gestão de Acessos)` });
  if(D.erros.length) al.push({ ic:"🔒", h:`<b>Sem acesso</b> a: ${esc(D.erros.map(e=>e.split(":")[0]).join(", "))}`, cls:"info" });
  if(!al.length) al.push({ ic:"✅", h:`<b>Operação sem alertas</b> no momento`, cls:"ok" });
  $("alertas").innerHTML = al.slice(0,6).map(a=>`<div class="al ${a.cls||""}"><div class="ic">${a.ic}</div><div>${a.h}</div></div>`).join("");
  ULTIMO = C;
}
let ULTIMO = null;
// lista da oficina: mostra o que cabe e vai passando as páginas a cada 10 s
function desenharOficina(C){
  C = C || ULTIMO; if(!C) return;
  const box = $("of-lista");
  if(!C.man.length){ box.innerHTML = `<div class="vazio"><b>✅</b>Nenhum veículo na oficina</div>`; $("of-pag").textContent = ""; return; }
  // mede a altura real de uma linha para saber quantas cabem
  const linha = (f) => {
    const crit = f.dias!=null && f.dias > TV_DIAS_ALERTA, obs = (f.of && f.of.observacao) || f.r.obs || "";
    return `<div class="of-row ${crit?"critico":""}" style="--c:${f.st.c}"><div class="n">Nº ${String(f.v.ordem??"").padStart(2,"0")}</div>
      <div class="p">${esc(f.v.placa)}<small>${esc(obs) || "&nbsp;"}</small></div>
      <div class="s" style="background:${f.st.c}26; color:${f.st.c}">${f.st.t}</div>
      <div class="d">${f.dias==null ? "—" : f.dias}<small>${f.dias==null ? "" : f.dias===1 ? "dia" : "dias"}</small></div></div>`; };
  box.innerHTML = linha(C.man[0]);
  const hLinha = (box.firstElementChild?.offsetHeight || 50) + fs(.6), porPag = Math.max(1, Math.floor((box.clientHeight + fs(.6)) / hLinha));
  const pags = Math.ceil(C.man.length / porPag); if(OF_PAG >= pags) OF_PAG = 0;
  box.innerHTML = C.man.slice(OF_PAG*porPag, OF_PAG*porPag + porPag).map(linha).join("");
  $("of-pag").textContent = pags > 1 ? `página ${OF_PAG+1} de ${pags}` : "";
}
setInterval(()=>{ OF_PAG++; desenharOficina(); }, 10000);

/* ---------------- ciclo ---------------- */
let ATUALIZANDO = false;
async function atualizar(){
  if(ATUALIZANDO || !sbTv) return; ATUALIZANDO = true;
  const vivo = $("tv-vivo");
  try{
    const D = await buscar();
    if(D.erros.length >= 7){ throw new Error(D.erros[0]); }
    renderizar(D);
    const d = new Date();
    vivo.classList.remove("erro"); vivo.querySelector("span").textContent = `Ao vivo · ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
    $("aviso").classList.remove("on");
  }catch(e){
    vivo.classList.add("erro"); vivo.querySelector("span").textContent = "Sem conexão";
    const a = $("aviso"); a.textContent = "⚠ Não foi possível atualizar — tentando de novo em 1 minuto"; a.classList.add("on");
  }finally{ ATUALIZANDO = false; }
}
window.tvRenderizarTeste = renderizar;   // usado só nos testes locais

async function iniciar(){
  if(!sbTv){ $("tv-vivo").querySelector("span").textContent = "Sem banco configurado"; return; }
  const { data:{ session } } = await sbTv.auth.getSession();
  if(!session){ $("login").classList.add("on"); return; }
  atualizar();
}
setInterval(()=>{ if(!$("login").classList.contains("on")) atualizar(); }, TV_ATUALIZA_MS);
setTimeout(()=>location.reload(), 4*3600e3);   // recarrega a cada 4 h para pegar versões novas do painel
window.addEventListener("resize", ()=>{ Object.values(charts).forEach(c=>c.destroy()); for(const k in charts) delete charts[k]; if(ULTIMO) renderizar(ULTIMO.D); });
// tela sempre acesa (quando o navegador da TV permite) e cursor some parado
async function manterAcesa(){ try{ if("wakeLock" in navigator) await navigator.wakeLock.request("screen"); }catch(e){} }
document.addEventListener("visibilitychange", ()=>{ if(document.visibilityState==="visible") manterAcesa(); }); manterAcesa();
let ocioso; document.addEventListener("mousemove", ()=>{ document.body.classList.remove("ocioso"); clearTimeout(ocioso); ocioso = setTimeout(()=>document.body.classList.add("ocioso"), 3000); });
iniciar();
