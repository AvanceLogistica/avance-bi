-- Rode isto UMA VEZ no SQL Editor do Supabase (https://app.supabase.com > seu projeto > SQL Editor)
-- Cria a tabela que guarda cada linha de contrato/faturamento importada da planilha
-- "Controle de Contratos_Faturamento" ou lançada avulsa pela tela "Entrada de Dados".

create table if not exists faturamento_lancamentos (
  id uuid primary key default gen_random_uuid(),
  contrato text,
  nf text,
  deadline date,
  doc text,
  balsa_viagem text,
  valor numeric not null,
  vencimento date,
  created_at timestamptz not null default now()
);

alter table faturamento_lancamentos enable row level security;

-- Mesma política aberta usada nas outras tabelas transacionais do painel (entregas_lancamentos,
-- diesel_abastecimentos, manutencao_lancamentos, compras_lancamentos, infracoes_lancamentos) — a
-- chave "anon" do app.js lê/grava direto. Se você configurou uma política diferente (mais restrita)
-- nas outras tabelas, ajuste aqui do mesmo jeito antes de usar a importação.
create policy "faturamento_lancamentos_select" on faturamento_lancamentos for select using (true);
create policy "faturamento_lancamentos_insert" on faturamento_lancamentos for insert with check (true);
create policy "faturamento_lancamentos_delete" on faturamento_lancamentos for delete using (true);
