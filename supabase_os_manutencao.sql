-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- O.S de Manutenção (aba da tela Emissão de NF): perfil "manutencao" (líder da oficina, só vê as O.S),
-- tabela das O.S, tabela de serviços (códigos e preços) e inventário de carretas.

alter table user_roles drop constraint if exists user_roles_papel_check;
alter table user_roles add constraint user_roles_papel_check check (papel in ('diretor','operacional','lider','monitoramento','coordenacao','manutencao'));

create or replace function acesso_os()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','operacional','coordenacao','manutencao'));
$$;
create or replace function gestao_tabela_os()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','coordenacao'));
$$;

create table if not exists manutencao_os (
  id uuid primary key default gen_random_uuid(),
  numero integer not null,
  entrada_data date not null,
  entrada_hora text,
  saida_data date,
  saida_hora text,
  frota text not null,
  placa text,
  itens jsonb not null default '[]',   -- [{cod, servico, qtd, un, mo, mat}] com o preço do dia
  obs text,
  criado_por text,
  atualizado_por text,
  atualizado_em timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists manutencao_os_entrada_idx on manutencao_os (entrada_data);

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

alter table manutencao_os enable row level security;
alter table os_servicos enable row level security;
alter table os_carretas enable row level security;

do $$
declare t text; pol record;
begin
  foreach t in array array['manutencao_os','os_servicos','os_carretas'] loop
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy if exists %I on %I', pol.policyname, t);
    end loop;
  end loop;
end $$;

create policy "manutencao_os_all" on manutencao_os for all to authenticated using (acesso_os()) with check (acesso_os());
create policy "os_servicos_select" on os_servicos for select to authenticated using (acesso_os());
create policy "os_servicos_write" on os_servicos for all to authenticated using (gestao_tabela_os()) with check (gestao_tabela_os());
create policy "os_carretas_select" on os_carretas for select to authenticated using (acesso_os());
create policy "os_carretas_write" on os_carretas for all to authenticated using (gestao_tabela_os()) with check (gestao_tabela_os());

notify pgrst, 'reload schema';
