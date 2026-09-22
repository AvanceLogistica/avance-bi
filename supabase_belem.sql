-- Rode isto no SQL Editor do Supabase. Cria as duas tabelas do módulo "Operação Belém".
-- Pode rodar mais de uma vez sem problema.

-- Todos os custos de Belém (combustível, mão de obra e peças) ficam numa tabela só, com a coluna
-- "categoria" separando os três. Assim o DRE soma tudo por mês de um jeito direto, e cada importação
-- (que vem de planilhas com formatos bem diferentes) é convertida pra esse formato único na entrada.
create table if not exists belem_lancamentos (
  id uuid primary key default gen_random_uuid(),
  data date not null,
  categoria text not null check (categoria in ('combustivel','mao_de_obra','pecas')),
  descricao text,      -- o que foi: peça comprada, posto de abastecimento, "Salário", "VT + VR"...
  referencia text,     -- a quem se refere: placa do veículo, centro de custo, fornecedor
  quantidade numeric,  -- litros (combustível) ou quantidade de peças; vazio quando não se aplica
  valor numeric not null,
  created_at timestamptz not null default now()
);

-- Receita bruta mensal do contrato. Só guarda os meses que fogem do valor padrão (R$ 85.000) —
-- qualquer mês sem linha aqui usa o padrão definido no app (RECEITA_BELEM_PADRAO).
create table if not exists belem_receita (
  mes text primary key,  -- no formato 'AAAA-MM', ex: '2026-01'
  valor numeric not null,
  created_at timestamptz not null default now()
);

alter table belem_lancamentos enable row level security;
alter table belem_receita enable row level security;

do $$
declare
  t text;
  pol record;
begin
  foreach t in array array['belem_lancamentos','belem_receita']
  loop
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy if exists %I on %I', pol.policyname, t);
    end loop;
    execute format('create policy %I on %I for select to authenticated using (true)', t || '_select_auth', t);
    execute format('create policy %I on %I for insert to authenticated with check (true)', t || '_insert_auth', t);
    execute format('create policy %I on %I for update to authenticated using (true) with check (true)', t || '_update_auth', t);
    execute format('create policy %I on %I for delete to authenticated using (true)', t || '_delete_auth', t);
  end loop;
end $$;
