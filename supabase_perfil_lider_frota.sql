-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
--
-- 1) Cria o perfil "lider" (só enxerga o Status da Frota).
-- 2) Fecha as tabelas de dados do painel (custos, hora extra, contas a pagar...) para Diretor e
--    Operacional — antes qualquer pessoa logada lia tudo direto pelo banco, mesmo sem ver a tela.
-- 3) Cria as tabelas do Status da Frota, compartilhadas entre líderes e diretoria.

-- 1) Perfil Líder ------------------------------------------------------------------------------
alter table user_roles drop constraint if exists user_roles_papel_check;
alter table user_roles add constraint user_roles_papel_check check (papel in ('diretor','operacional','lider'));

create or replace function eh_equipe_interna()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','operacional'));
$$;

create or replace function tem_acesso_frota()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','operacional','lider'));
$$;

-- Hora extra (caso o SQL dela ainda não tenha sido rodado)
create table if not exists horaextra_lancamentos (
  id uuid primary key default gen_random_uuid(),
  colaborador text not null,
  funcao text,
  mes date not null,
  total numeric not null default 0,
  he20 numeric default 0,
  he50 numeric default 0,
  he100 numeric default 0,
  dissidio numeric default 0,
  created_at timestamptz not null default now()
);

-- 2) Tabelas de dados: só Diretor e Operacional ------------------------------------------------
do $$
declare
  t text;
  pol record;
begin
  foreach t in array array[
    'compras_lancamentos','contas_pagar','series_periodo','eventos_diarios','acidentes_acoes',
    'manutencao_lancamentos','diesel_abastecimentos','infracoes_lancamentos','entregas_lancamentos',
    'faturamento_lancamentos','belem_lancamentos','belem_receita','atestados_lancamentos','horaextra_lancamentos'
  ]
  loop
    if to_regclass('public.' || t) is null then
      raise notice 'tabela % nao existe, pulando', t;
      continue;
    end if;
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy if exists %I on %I', pol.policyname, t);
    end loop;
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select to authenticated using (eh_equipe_interna())', t || '_select_equipe', t);
    execute format('create policy %I on %I for insert to authenticated with check (eh_equipe_interna())', t || '_insert_equipe', t);
    execute format('create policy %I on %I for update to authenticated using (eh_equipe_interna()) with check (eh_equipe_interna())', t || '_update_equipe', t);
    execute format('create policy %I on %I for delete to authenticated using (eh_equipe_interna())', t || '_delete_equipe', t);
  end loop;
end $$;

-- 3) Status da Frota ---------------------------------------------------------------------------
create table if not exists frota_veiculos (
  id uuid primary key default gen_random_uuid(),
  ordem int not null,
  placa text not null,
  motorista text,
  atividade_padrao text,
  obs text,
  created_at timestamptz not null default now()
);

create table if not exists frota_status (
  id uuid primary key default gen_random_uuid(),
  data date not null,
  veiculo_id uuid not null references frota_veiculos(id) on delete cascade,
  atividade text not null,
  motorista text,
  status text not null,
  obs text,
  atualizado_por text,
  atualizado_em timestamptz not null default now(),
  unique (data, veiculo_id)
);

alter table frota_veiculos enable row level security;
alter table frota_status enable row level security;

do $$
declare
  t text;
  pol record;
begin
  foreach t in array array['frota_veiculos','frota_status'] loop
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy if exists %I on %I', pol.policyname, t);
    end loop;
  end loop;
end $$;

-- Cadastro de caminhões: todos da frota leem, só o Diretor altera
create policy "frota_veiculos_select" on frota_veiculos for select to authenticated using (tem_acesso_frota());
create policy "frota_veiculos_write_diretor" on frota_veiculos for all to authenticated using (eh_diretor()) with check (eh_diretor());

-- Status do dia: líderes, operacional e diretoria leem e lançam
create policy "frota_status_select" on frota_status for select to authenticated using (tem_acesso_frota());
create policy "frota_status_insert" on frota_status for insert to authenticated with check (tem_acesso_frota());
create policy "frota_status_update" on frota_status for update to authenticated using (tem_acesso_frota()) with check (tem_acesso_frota());
create policy "frota_status_delete_diretor" on frota_status for delete to authenticated using (eh_diretor());

notify pgrst, 'reload schema';
