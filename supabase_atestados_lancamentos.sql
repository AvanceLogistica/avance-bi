-- Rode isto no SQL Editor do Supabase. Cria a tabela que guarda cada atestado/afastamento importado
-- da aba "LANÇAMENTOS" da planilha "Controle_Atestados_Afastamentos".
-- Pode rodar mais de uma vez sem problema.

create table if not exists atestados_lancamentos (
  id uuid primary key default gen_random_uuid(),
  data date not null,
  colaborador text,
  motivo text,          -- motivo / CID, como vem na planilha
  categoria text,       -- agrupamento do motivo (Osteomuscular, Odontológico, ...)
  horas numeric,        -- horas perdidas; vazio em lançamentos que não têm essa informação
  dias numeric,         -- dias de afastamento (pode ser fracionado, ex: 0,5)
  data_retorno date,
  observacao text,
  created_at timestamptz not null default now()
);

alter table atestados_lancamentos enable row level security;

do $$
declare
  pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'atestados_lancamentos' loop
    execute format('drop policy if exists %I on atestados_lancamentos', pol.policyname);
  end loop;
end $$;

create policy "atestados_lancamentos_select_auth" on atestados_lancamentos for select to authenticated using (true);
create policy "atestados_lancamentos_insert_auth" on atestados_lancamentos for insert to authenticated with check (true);
create policy "atestados_lancamentos_update_auth" on atestados_lancamentos for update to authenticated using (true) with check (true);
create policy "atestados_lancamentos_delete_auth" on atestados_lancamentos for delete to authenticated using (true);
