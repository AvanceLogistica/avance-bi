-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Controle diário de carretas (Manutenção de Carreta) + perfil "oficina" (só essa tela).

alter table user_roles drop constraint if exists user_roles_papel_check;
alter table user_roles add constraint user_roles_papel_check check (papel in ('diretor','operacional','lider','monitoramento','coordenacao','manutencao','rh','oficina'));

create or replace function acesso_oficina()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','operacional','oficina'));
$$;

create table if not exists carretas_fila (
  id uuid primary key default gen_random_uuid(),
  frota text not null,
  placa text,
  data_entrada date not null,
  data_conclusao date,
  obs text,
  criado_por text,
  atualizado_por text,
  atualizado_em timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create table if not exists carretas_plano (
  data date primary key,
  planejado integer not null default 0,
  obs text,
  atualizado_por text,
  atualizado_em timestamptz not null default now()
);

alter table carretas_fila enable row level security;
alter table carretas_plano enable row level security;
drop policy if exists "carretas_fila_all" on carretas_fila;
drop policy if exists "carretas_plano_all" on carretas_plano;
create policy "carretas_fila_all" on carretas_fila for all to authenticated using (acesso_oficina()) with check (acesso_oficina());
create policy "carretas_plano_all" on carretas_plano for all to authenticated using (acesso_oficina()) with check (acesso_oficina());

-- a oficina usa a mesma lista de carretas da O.S de Manutenção (só leitura)
drop policy if exists "os_carretas_select_oficina" on os_carretas;
create policy "os_carretas_select_oficina" on os_carretas for select to authenticated using (acesso_oficina());

notify pgrst, 'reload schema';
