-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- BALSAS EM TRÂNSITO (tela Balsas): balsa, previsão de chegada, quantidade de rack/peça e mercado (Total = rack + mercado, calculado na tela).
-- A coluna carga saiu da tela (25/11/2026) e não é mais usada; fica no banco com 0.
-- chegada vazia = ainda em trânsito. Mesmo acesso das operações de balsa (acesso_pier).
create table if not exists balsa_transito (
  id uuid primary key default gen_random_uuid(),
  balsa text not null,
  previsao date not null,
  carga numeric(12,2) not null default 0,
  rack integer not null default 0,
  chegada date,
  criado_por text,
  atualizado_por text,
  atualizado_em timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table balsa_transito add column if not exists mercado integer not null default 0;
alter table balsa_transito enable row level security;
drop policy if exists "balsa_transito_acesso" on balsa_transito;
create policy "balsa_transito_acesso" on balsa_transito for all to authenticated using (acesso_pier()) with check (acesso_pier());

notify pgrst, 'reload schema';
select 'ok — Balsas em trânsito pronto' as resultado;
