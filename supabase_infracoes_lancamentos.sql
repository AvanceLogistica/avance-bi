-- Rode isto UMA VEZ no SQL Editor do Supabase (https://app.supabase.com > seu projeto > SQL Editor)
-- Cria a tabela que guarda cada ocorrência de infração importada da planilha "Lista de Infrações"
-- (aba Matriz) ou lançada avulsa pela tela "Entrada de Dados".

create table if not exists infracoes_lancamentos (
  id uuid primary key default gen_random_uuid(),
  data date not null,
  motorista text,
  placa text,
  turno text,
  hora text,
  ocorrencia text,
  observacoes text,
  created_at timestamptz not null default now()
);

alter table infracoes_lancamentos enable row level security;

-- Mesma política aberta usada nas outras tabelas transacionais do painel (diesel_abastecimentos,
-- manutencao_lancamentos, compras_lancamentos) — a chave "anon" do app.js lê/grava direto.
-- Se você configurou uma política diferente (mais restrita) nas outras tabelas, ajuste aqui do
-- mesmo jeito antes de usar a importação.
create policy "infracoes_lancamentos_select" on infracoes_lancamentos for select using (true);
create policy "infracoes_lancamentos_insert" on infracoes_lancamentos for insert with check (true);
create policy "infracoes_lancamentos_delete" on infracoes_lancamentos for delete using (true);
