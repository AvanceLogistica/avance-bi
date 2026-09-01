-- Rode isto UMA VEZ no SQL Editor do Supabase (https://app.supabase.com > seu projeto > SQL Editor)
-- Cria a tabela que guarda cada operação de entrega/coleta importada da planilha
-- "Demonstrativo de ENTREGAS" (aba MATRIZ) ou lançada avulsa pela tela "Entrada de Dados".

create table if not exists entregas_lancamentos (
  id uuid primary key default gen_random_uuid(),
  data date not null,
  servico text,
  transportadora text,
  cliente text,
  motorista text,
  carro text,
  qnt integer not null default 1,
  valor numeric not null,
  observacao text,
  created_at timestamptz not null default now()
);

alter table entregas_lancamentos enable row level security;

-- Mesma política aberta usada nas outras tabelas transacionais do painel (diesel_abastecimentos,
-- manutencao_lancamentos, compras_lancamentos, infracoes_lancamentos) — a chave "anon" do app.js
-- lê/grava direto. Se você configurou uma política diferente (mais restrita) nas outras tabelas,
-- ajuste aqui do mesmo jeito antes de usar a importação.
create policy "entregas_lancamentos_select" on entregas_lancamentos for select using (true);
create policy "entregas_lancamentos_insert" on entregas_lancamentos for insert with check (true);
create policy "entregas_lancamentos_delete" on entregas_lancamentos for delete using (true);
