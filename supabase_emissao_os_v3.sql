-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Emissão de O.S: plano do dia (operação) → validação do líder → O.S da administração.
alter table manutencao_os add column if not exists pre_id uuid;
alter table manutencao_os add column if not exists data_plano date;
alter table manutencao_os add column if not exists lider_por text;
alter table manutencao_os add column if not exists lider_em timestamptz;
alter table manutencao_os add column if not exists referencia text;

-- Dados do cabeçalho da O.S (Avance e cliente) — ficam no banco, não no código do site
create table if not exists app_config (
  chave text primary key,
  valor jsonb,
  atualizado_por text,
  atualizado_em timestamptz not null default now()
);
alter table app_config enable row level security;
drop policy if exists "app_config_select" on app_config;
create policy "app_config_select" on app_config for select to authenticated using (acesso_os());
drop policy if exists "app_config_write" on app_config;
create policy "app_config_write" on app_config for all to authenticated using (gestao_tabela_os()) with check (gestao_tabela_os());

notify pgrst, 'reload schema';
