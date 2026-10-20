-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Perfil "rh": entra no sistema e só enxerga o Organograma (cadastra, edita, foto, desliga).

alter table user_roles drop constraint if exists user_roles_papel_check;
alter table user_roles add constraint user_roles_papel_check check (papel in ('diretor','operacional','lider','monitoramento','coordenacao','manutencao','rh'));

create or replace function acesso_organograma()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','rh'));
$$;

drop policy if exists "colaboradores_diretor" on colaboradores;
drop policy if exists "colaboradores_acesso" on colaboradores;
create policy "colaboradores_acesso" on colaboradores for all to authenticated using (acesso_organograma()) with check (acesso_organograma());

notify pgrst, 'reload schema';
