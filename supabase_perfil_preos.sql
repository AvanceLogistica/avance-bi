-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Perfil "preos" (Operação): só a tela de Pré O.S / plano do dia (lança e valida, sem valores).
alter table user_roles drop constraint if exists user_roles_papel_check;
alter table user_roles add constraint user_roles_papel_check check (papel in ('diretor','operacional','lider','monitoramento','coordenacao','manutencao','rh','oficina','administrativo','preos'));

create or replace function acesso_os()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','operacional','coordenacao','manutencao','oficina','administrativo','preos'));
$$;

insert into user_roles (user_id, email, papel)
select id, email, 'preos' from auth.users where email = 'alexevisramon13@gmail.com'
on conflict (user_id) do update set papel = excluded.papel;

notify pgrst, 'reload schema';

select u.email, coalesce(r.papel, 'sem perfil') as perfil
from auth.users u left join user_roles r on r.user_id = u.id
where u.email = 'alexevisramon13@gmail.com';
