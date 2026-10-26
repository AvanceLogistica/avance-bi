-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Infrações › Sinistro: registro por placa (quem, como, quando, aonde, análise) com evidências.
create table if not exists sinistros (
  id uuid primary key default gen_random_uuid(),
  numero integer,
  veiculo_id uuid references frota_veiculos(id) on delete set null,
  placa text not null,
  data date not null,
  hora text,
  quem text,
  como text,
  quando text,
  aonde text,
  analise text,
  anexos jsonb not null default '[]',   -- fotos (reduzidas) e arquivos em data URL
  anexos_qtd integer not null default 0,
  criado_por text,
  atualizado_por text,
  atualizado_em timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table sinistros enable row level security;
drop policy if exists "sinistros_equipe" on sinistros;
create policy "sinistros_equipe" on sinistros for all to authenticated using (eh_equipe_interna()) with check (eh_equipe_interna());
notify pgrst, 'reload schema';
