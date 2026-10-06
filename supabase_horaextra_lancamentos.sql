-- Rode isto no SQL Editor do Supabase. Cria a tabela que guarda cada lançamento de hora extra
-- (um por colaborador e mês, em R$) importado da planilha "Controle de Hora Extra_em R$".
-- Pode rodar mais de uma vez sem problema.

create table if not exists horaextra_lancamentos (
  id uuid primary key default gen_random_uuid(),
  colaborador text not null,
  funcao text,
  mes date not null,      -- sempre o dia 1 do mês de referência
  total numeric not null default 0,
  he20 numeric default 0,
  he50 numeric default 0,
  he100 numeric default 0,
  dissidio numeric default 0,  -- dissídio maio + dissídio 50%
  created_at timestamptz not null default now()
);

alter table horaextra_lancamentos enable row level security;

do $$
declare
  pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'horaextra_lancamentos' loop
    execute format('drop policy if exists %I on horaextra_lancamentos', pol.policyname);
  end loop;
end $$;

create policy "horaextra_lancamentos_select_auth" on horaextra_lancamentos for select to authenticated using (true);
create policy "horaextra_lancamentos_insert_auth" on horaextra_lancamentos for insert to authenticated with check (true);
create policy "horaextra_lancamentos_update_auth" on horaextra_lancamentos for update to authenticated using (true) with check (true);
create policy "horaextra_lancamentos_delete_auth" on horaextra_lancamentos for delete to authenticated using (true);
