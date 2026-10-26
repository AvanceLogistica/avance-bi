-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Perfil "frotaoficina": só a aba Oficina do Status da Frota.
alter table user_roles drop constraint if exists user_roles_papel_check;
alter table user_roles add constraint user_roles_papel_check check (papel in ('diretor','operacional','lider','monitoramento','coordenacao','manutencao','rh','oficina','administrativo','preos','frotaoficina'));

create or replace function tem_acesso_frota()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','operacional','lider','coordenacao','frotaoficina'));
$$;

-- confirma o e-mail (dispensa o link de confirmação) e libera o acesso
update auth.users set email_confirmed_at = now()
where lower(email) = lower('Lorenzo_81230309@hotmail.com') and email_confirmed_at is null;

insert into user_roles (user_id, email, papel)
select id, email, 'frotaoficina' from auth.users where lower(email) = lower('Lorenzo_81230309@hotmail.com')
on conflict (user_id) do update set papel = excluded.papel;

notify pgrst, 'reload schema';

select u.email, u.email_confirmed_at is not null as email_confirmado, coalesce(r.papel, 'sem perfil') as perfil
from auth.users u left join user_roles r on r.user_id = u.id
where lower(u.email) = lower('Lorenzo_81230309@hotmail.com');
