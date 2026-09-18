-- Rode isto no SQL Editor do Supabase. Resolve DOIS problemas de uma vez:
--
-- 1) CORRIGE A GRAVAÇÃO QUEBRADA PELO LOGIN. As tabelas foram criadas quando o site acessava o banco
--    como visitante anônimo ("anon"), e as permissões liberavam só esse perfil. Depois que o login
--    passou a existir, o site acessa como usuário autenticado ("authenticated") — outro perfil, que
--    aquelas permissões não cobriam. Resultado: importar planilha dava
--    "new row violates row-level security policy". Aqui as permissões passam a valer pra quem está
--    logado, que é como o site funciona hoje.
--
-- 2) FECHA O ACESSO DIRETO AO BANCO. Hoje qualquer pessoa com a URL/chave pública (que ficam no
--    código-fonte do site) consegue ler e alterar os dados sem nunca passar pela tela de login.
--    Depois disso, só quem estiver logado consegue.
--
-- Pode rodar mais de uma vez sem problema — sempre remove as permissões antigas da tabela antes de
-- criar as novas, então nunca duplica nem deixa uma permissão antiga esquecida por engano.
--
-- Obs: a tabela user_roles (perfis Diretor/Operacional) NÃO é mexida aqui — ela tem as permissões
-- próprias dela, criadas em supabase_user_roles.sql.

do $$
declare
  t text;
  pol record;
begin
  foreach t in array array[
    'compras_lancamentos','contas_pagar','series_periodo','eventos_diarios','acidentes_acoes',
    'manutencao_lancamentos','diesel_abastecimentos','infracoes_lancamentos','entregas_lancamentos',
    'faturamento_lancamentos'
  ]
  loop
    -- remove TODAS as permissões existentes na tabela, seja qual for o nome ou o perfil delas
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy if exists %I on %I', pol.policyname, t);
    end loop;

    execute format('alter table %I enable row level security', t);

    -- "to authenticated" é o que garante que vale pra quem está logado pelo site. É mais confiável
    -- do que checar auth.role() dentro da condição, porque o próprio Postgres filtra pelo perfil.
    execute format('create policy %I on %I for select to authenticated using (true)', t || '_select_auth', t);
    execute format('create policy %I on %I for insert to authenticated with check (true)', t || '_insert_auth', t);
    execute format('create policy %I on %I for update to authenticated using (true) with check (true)', t || '_update_auth', t);
    execute format('create policy %I on %I for delete to authenticated using (true)', t || '_delete_auth', t);
  end loop;
end $$;
