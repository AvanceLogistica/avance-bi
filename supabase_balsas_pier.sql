-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- BALSAS: abertura e fechamento das operações nos piers (Panamá / Luiza), viagens Plano × Real.
-- Usa a tabela balsa_operacoes (do Painel TV): data = dia da abertura, hora_inicio = hora da abertura,
-- data_fechamento / hora_fim = fechamento, viagens_plano = plano, viagens = real.
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
alter table balsa_operacoes add column if not exists numero text;
alter table balsa_operacoes add column if not exists data_fechamento date;
alter table balsa_operacoes add column if not exists viagens_plano integer not null default 0;
create index if not exists balsa_operacoes_data on balsa_operacoes (data);
create index if not exists balsa_operacoes_abertas on balsa_operacoes (pier) where data_fechamento is null;
alter table balsa_operacoes enable row level security;

create or replace function acesso_pier()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','operacional','monitoramento','coordenacao')) or tem_pagina_extra('pier');
$$;
drop policy if exists "balsa_operacoes_acesso" on balsa_operacoes;
create policy "balsa_operacoes_acesso" on balsa_operacoes for all to authenticated using (acesso_pier()) with check (acesso_pier());

notify pgrst, 'reload schema';
select 'ok — Balsas pronto' as resultado;
