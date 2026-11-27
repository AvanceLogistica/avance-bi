-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- HORA EXTRA EM HORAS: PDF "Relatório de Extras Abonadas" do ponto (Poliponto), importado na tela Hora Extra → aba Em horas.
-- Uma linha por colaborador e período do relatório. Horas em minutos (e50/e100 = Extra 50%/100%; a50/a100 = Ext Adi, adicional noturno).
-- dias = lista dos dias com os horários (1º período, intervalo, 2º período) e o total do dia.
create table if not exists horaextra_ponto (
  id uuid primary key default gen_random_uuid(),
  matricula text not null,
  nome text,
  periodo_ini date not null,
  periodo_fim date not null,
  e50 integer not null default 0,
  e100 integer not null default 0,
  a50 integer not null default 0,
  a100 integer not null default 0,
  dias jsonb not null default '[]'::jsonb,
  importado_por text,
  created_at timestamptz not null default now()
);
create index if not exists horaextra_ponto_periodo on horaextra_ponto (periodo_fim);
alter table horaextra_ponto enable row level security;
drop policy if exists "horaextra_ponto_select" on horaextra_ponto;
drop policy if exists "horaextra_ponto_insert" on horaextra_ponto;
drop policy if exists "horaextra_ponto_delete" on horaextra_ponto;
create policy "horaextra_ponto_select" on horaextra_ponto for select to authenticated using (true);
create policy "horaextra_ponto_insert" on horaextra_ponto for insert to authenticated with check (true);
create policy "horaextra_ponto_delete" on horaextra_ponto for delete to authenticated using (true);

notify pgrst, 'reload schema';
select 'ok — Hora Extra em horas pronto' as resultado;
