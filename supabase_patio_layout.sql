-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Manutenção de Carreta › Pátio (mapa do dia): uma linha por dia com a posição de cada carreta.
create table if not exists patio_layout (
  data date primary key,
  posicoes jsonb not null default '{}'::jsonb,
  atualizado_por text,
  atualizado_em timestamptz not null default now()
);
alter table patio_layout enable row level security;
drop policy if exists "patio_layout_all" on patio_layout;
create policy "patio_layout_all" on patio_layout for all to authenticated using (acesso_oficina()) with check (acesso_oficina());
notify pgrst, 'reload schema';
