-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Painel de emissão de NF (aba NF Emitidas): período de cada NF + status manual por período
-- (em andamento / sem operação) com o motivo.

alter table nf_emitidas add column if not exists periodo text;   -- ex: S:2026-10-05 (semana), Q:2026-10-1 (quinzena), M:2026-10 (mês)

create table if not exists nf_painel (
  id uuid primary key default gen_random_uuid(),
  atividade text not null,
  periodo text not null,
  status text,                 -- andamento | sem_operacao | (vazio)
  obs text,
  atualizado_por text,
  atualizado_em timestamptz not null default now(),
  unique (atividade, periodo)
);

alter table nf_painel enable row level security;
drop policy if exists "nf_painel_all" on nf_painel;
create policy "nf_painel_all" on nf_painel for all to authenticated using (acesso_faturamento()) with check (acesso_faturamento());

notify pgrst, 'reload schema';
