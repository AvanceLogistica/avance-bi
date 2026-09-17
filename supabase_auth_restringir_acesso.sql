-- Rode isto no SQL Editor do Supabase SÓ DEPOIS de confirmar que o login (e-mail/senha) do site já
-- está funcionando — se rodar antes, ninguém mais vai conseguir ver os dados até fazer login.
--
-- O que faz: troca a política de acesso de TODAS as tabelas do painel, que hoje estão abertas pra
-- qualquer pessoa com a URL/chave pública do Supabase (usadas em supabase-config.js, que fica no
-- código-fonte do site), para exigir um usuário autenticado (logado) pra ler ou gravar qualquer coisa.
--
-- Pode rodar mais de uma vez sem problema — sempre remove as políticas antigas da tabela antes de
-- criar as novas, então nunca duplica nem deixa uma política antiga "aberta" esquecida por engano.

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
    -- remove TODAS as políticas existentes na tabela, seja qual for o nome delas
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy if exists %I on %I', pol.policyname, t);
    end loop;

    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select using (auth.role() = ''authenticated'')', t || '_select_auth', t);
    execute format('create policy %I on %I for insert with check (auth.role() = ''authenticated'')', t || '_insert_auth', t);
    execute format('create policy %I on %I for update using (auth.role() = ''authenticated'') with check (auth.role() = ''authenticated'')', t || '_update_auth', t);
    execute format('create policy %I on %I for delete using (auth.role() = ''authenticated'')', t || '_delete_auth', t);
  end loop;
end $$;
