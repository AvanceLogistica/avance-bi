-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Perfil "administrativo": Emissão de O.S (conferir Pré O.S, emitir O.S, assinatura e nº da NF) + Organograma.
alter table user_roles drop constraint if exists user_roles_papel_check;
alter table user_roles add constraint user_roles_papel_check check (papel in ('diretor','operacional','lider','monitoramento','coordenacao','manutencao','rh','oficina','administrativo'));

create or replace function acesso_os()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','operacional','coordenacao','manutencao','oficina','administrativo'));
$$;
create or replace function gestao_tabela_os()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','coordenacao','administrativo'));
$$;
create or replace function acesso_organograma()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','rh','administrativo'));
$$;
-- a O.S emitida atualiza o ciclo semanal da Combitrans
drop policy if exists "manut_ciclos_os" on manut_ciclos;
create policy "manut_ciclos_os" on manut_ciclos for all to authenticated using (acesso_os()) with check (acesso_os());

-- avancelogisticaintegrada@gmail.com passa a ser Administrativo
insert into user_roles (user_id, email, papel)
select id, email, 'administrativo' from auth.users where email = 'avancelogisticaintegrada@gmail.com'
on conflict (user_id) do update set papel = excluded.papel;

notify pgrst, 'reload schema';

select u.email, coalesce(r.papel, 'sem perfil') as perfil
from auth.users u left join user_roles r on r.user_id = u.id
where u.email = 'avancelogisticaintegrada@gmail.com';
