-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Emissão de O.S: a operação lança a Pré O.S no Controle diário de carretas (perfil oficina) e o
-- administrativo (Diretor / Coordenação) confere e emite a O.S para a Combitrans.

create table if not exists manutencao_os (
  id uuid primary key default gen_random_uuid(),
  numero integer,
  entrada_data date not null,
  entrada_hora text,
  saida_data date,
  saida_hora text,
  frota text not null,
  placa text,
  itens jsonb not null default '[]',
  obs text,
  criado_por text,
  atualizado_por text,
  atualizado_em timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create table if not exists os_servicos (
  id uuid primary key default gen_random_uuid(),
  cod integer not null,
  servico text not null,
  grupo text,
  mo numeric,
  mat numeric
);
create table if not exists os_carretas (
  id uuid primary key default gen_random_uuid(),
  placa text not null,
  frota text not null
);

-- Pré O.S: ainda sem número; status "pre" (lançada pela operação) ou "emitida" (validada pelo administrativo)
alter table manutencao_os alter column numero drop not null;
alter table manutencao_os add column if not exists status text not null default 'emitida';
alter table manutencao_os add column if not exists fila_id uuid;
alter table manutencao_os add column if not exists valor numeric(14,2);
alter table manutencao_os add column if not exists emitida_em timestamptz;
alter table manutencao_os add column if not exists emitida_por text;

-- quem lança e quem emite
create or replace function acesso_os()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','operacional','coordenacao','manutencao','oficina'));
$$;
create or replace function gestao_tabela_os()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','coordenacao'));
$$;

alter table manutencao_os enable row level security;
alter table os_servicos enable row level security;
alter table os_carretas enable row level security;
drop policy if exists "manutencao_os_all" on manutencao_os;
create policy "manutencao_os_all" on manutencao_os for all to authenticated using (acesso_os()) with check (acesso_os());
drop policy if exists "os_servicos_select" on os_servicos;
create policy "os_servicos_select" on os_servicos for select to authenticated using (acesso_os());
drop policy if exists "os_servicos_write" on os_servicos;
create policy "os_servicos_write" on os_servicos for all to authenticated using (gestao_tabela_os()) with check (gestao_tabela_os());
drop policy if exists "os_carretas_select" on os_carretas;
create policy "os_carretas_select" on os_carretas for select to authenticated using (acesso_os());
drop policy if exists "os_carretas_write" on os_carretas;
create policy "os_carretas_write" on os_carretas for all to authenticated using (gestao_tabela_os()) with check (gestao_tabela_os());

notify pgrst, 'reload schema';

-- confere: quantos serviços tem na tabela de preços e quantas O.S existem
select (select count(*) from os_servicos) as servicos_na_tabela, (select count(*) from manutencao_os) as os_cadastradas;
