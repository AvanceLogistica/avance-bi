-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Recursos Humanos: ficha cadastral de cada funcionário (uma por colaborador do Organograma).
-- Dados pessoais, documentos, salário e conta bancária: acesso SOMENTE de Diretor e RH.

create or replace function acesso_rh()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','rh'));
$$;

create table if not exists rh_fichas (
  colaborador_id uuid primary key references colaboradores(id) on delete cascade,
  dados jsonb not null default '{}'::jsonb,
  atualizado_por text,
  atualizado_em timestamptz not null default now()
);
alter table rh_fichas enable row level security;
drop policy if exists "rh_fichas_acesso" on rh_fichas;
create policy "rh_fichas_acesso" on rh_fichas for all to authenticated using (acesso_rh()) with check (acesso_rh());

notify pgrst, 'reload schema';
