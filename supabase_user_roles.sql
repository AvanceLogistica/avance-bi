-- Rode isto no SQL Editor do Supabase depois de confirmar que o login (e-mail/senha) já está
-- funcionando. Cria o sistema de PERFIS (Diretor / Operacional) que controla quais telas cada pessoa
-- vê no painel, além de uma função que a tela "Gestão de Acessos" do site usa pra listar todo mundo
-- que já se cadastrou (inclusive quem ainda não tem perfil, aguardando liberação).
--
-- Pode rodar mais de uma vez sem problema (os "if not exists"/"or replace" cobrem isso).

create table if not exists user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  papel text not null check (papel in ('diretor','operacional')),
  created_at timestamptz not null default now()
);

alter table user_roles enable row level security;

drop policy if exists "user_roles_select_own" on user_roles;
drop policy if exists "user_roles_write_diretor" on user_roles;

-- Todo usuário autenticado consegue ler APENAS a própria linha, pra saber seu próprio perfil ao logar.
create policy "user_roles_select_own" on user_roles for select
  using (auth.uid() = user_id);

-- Só quem já é 'diretor' consegue criar/alterar/apagar perfil de qualquer usuário (inclusive o
-- próprio) — assim ninguém consegue se auto-promover, e só um diretor já existente pode liberar
-- acesso de gente nova.
create policy "user_roles_write_diretor" on user_roles for all
  using (exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.papel = 'diretor'))
  with check (exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.papel = 'diretor'));

-- Função usada pela tela "Gestão de Acessos": lista todo mundo que já se cadastrou (auth.users),
-- junto com o perfil de cada um (ou "sem_perfil" pra quem ainda está aguardando liberação). Roda com
-- privilégio elevado (security definer) porque a tabela auth.users não é visível pro cliente comum,
-- mas SÓ devolve alguma coisa se quem chamou já for diretor — qualquer outro usuário autenticado que
-- tentar chamar recebe um erro, não a lista.
create or replace function listar_usuarios_para_gestao()
returns table(user_id uuid, email text, papel text, criado_em timestamptz)
language plpgsql security definer
set search_path = public
as $$
begin
  if not exists (select 1 from user_roles where user_id = auth.uid() and papel = 'diretor') then
    raise exception 'Acesso negado — só um Diretor pode listar os usuários.';
  end if;
  return query
    select u.id, u.email::text, coalesce(ur.papel, 'sem_perfil'), u.created_at
    from auth.users u
    left join user_roles ur on ur.user_id = u.id
    order by u.created_at desc;
end;
$$;

revoke all on function listar_usuarios_para_gestao() from public;
grant execute on function listar_usuarios_para_gestao() to authenticated;

-- Libera os dois e-mails abaixo como Diretor (acesso total) pra começar. Só funciona pra e-mails que
-- JÁ se cadastraram no site (senão a busca não encontra ninguém e não faz nada, sem erro) — rode de
-- novo depois se cadastrar outros diretores por e-mail.
insert into user_roles (user_id, email, papel)
select id, email, 'diretor' from auth.users
where email in ('diretor.avance@gmail.com', 'fabianosr@yahoo.com.br')
on conflict (user_id) do update set papel = excluded.papel;
