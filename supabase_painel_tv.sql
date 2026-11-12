-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- PAINEL TV (tv.html) + OPERAÇÃO NO PIER (descarga / carregamento de balsas)

-- 1) novo perfil "tv": só abre o Painel TV, somente leitura
alter table user_roles drop constraint if exists user_roles_papel_check;
alter table user_roles add constraint user_roles_papel_check check (papel in ('diretor','operacional','lider','monitoramento','coordenacao','manutencao','rh','oficina','administrativo','preos','frotaoficina','patio','personalizado','tv'));

create or replace function eh_tv()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel = 'tv');
$$;

-- 2) operações de balsa no pier (Panamá / Luiza): viagens de descarga e carregamento por balsa
create table if not exists balsa_operacoes (
  id uuid primary key default gen_random_uuid(),
  data date not null,
  pier text not null check (pier in ('panama','luiza')),
  balsa text not null,
  tipo text not null check (tipo in ('descarga','carregamento')),
  viagens integer not null default 0,
  hora_inicio text,
  hora_fim text,
  obs text,
  criado_por text,
  atualizado_por text,
  atualizado_em timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists balsa_operacoes_data on balsa_operacoes (data);
alter table balsa_operacoes enable row level security;

-- quem lança: Diretoria, Operacional, Monitoramento, Coordenação ou quem tiver a tela "pier" como extra
create or replace function acesso_pier()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','operacional','monitoramento','coordenacao')) or tem_pagina_extra('pier');
$$;
drop policy if exists "balsa_operacoes_acesso" on balsa_operacoes;
create policy "balsa_operacoes_acesso" on balsa_operacoes for all to authenticated using (acesso_pier()) with check (acesso_pier());

-- 3) a TV só LÊ os dados que aparecem no painel
drop policy if exists "balsa_operacoes_select_tv" on balsa_operacoes;
create policy "balsa_operacoes_select_tv" on balsa_operacoes for select to authenticated using (eh_tv());
drop policy if exists "frota_veiculos_select_tv" on frota_veiculos;
create policy "frota_veiculos_select_tv" on frota_veiculos for select to authenticated using (eh_tv());
drop policy if exists "frota_status_select_tv" on frota_status;
create policy "frota_status_select_tv" on frota_status for select to authenticated using (eh_tv());
drop policy if exists "frota_oficina_select_tv" on frota_oficina;
create policy "frota_oficina_select_tv" on frota_oficina for select to authenticated using (eh_tv());
drop policy if exists "prog_select_tv" on entregas_programacao;
create policy "prog_select_tv" on entregas_programacao for select to authenticated using (eh_tv());
drop policy if exists "carretas_fila_select_tv" on carretas_fila;
create policy "carretas_fila_select_tv" on carretas_fila for select to authenticated using (eh_tv());

notify pgrst, 'reload schema';

select 'ok — Painel TV pronto' as resultado;
