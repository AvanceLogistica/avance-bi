-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Status da Frota também para o perfil Coordenação, e acesso para avancelogistica.coord@gmail.com
-- (se ainda não tiver perfil, entra como Líder = só o Status da Frota).
create or replace function tem_acesso_frota()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','operacional','lider','coordenacao'));
$$;

insert into user_roles (user_id, email, papel)
select id, email, 'lider' from auth.users where email = 'avancelogistica.coord@gmail.com'
on conflict (user_id) do nothing;

-- Confere: se não aparecer nenhuma linha, a pessoa ainda não criou a conta no sistema
select u.email, coalesce(r.papel, 'sem perfil') as perfil
from auth.users u left join user_roles r on r.user_id = u.id
where u.email = 'avancelogistica.coord@gmail.com';
