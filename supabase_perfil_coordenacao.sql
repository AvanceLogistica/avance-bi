-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Cria o perfil "coordenacao" (só enxerga a tela Emissão de NF) e libera para ele apenas a tabela
-- faturamento_lancamentos. As demais tabelas continuam só para Diretor e Operacional.

alter table user_roles drop constraint if exists user_roles_papel_check;
alter table user_roles add constraint user_roles_papel_check check (papel in ('diretor','operacional','lider','monitoramento','coordenacao'));

create or replace function acesso_faturamento()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','operacional','coordenacao'));
$$;

drop policy if exists "faturamento_lancamentos_select_coord" on faturamento_lancamentos;
drop policy if exists "faturamento_lancamentos_insert_coord" on faturamento_lancamentos;
drop policy if exists "faturamento_lancamentos_update_coord" on faturamento_lancamentos;
drop policy if exists "faturamento_lancamentos_delete_coord" on faturamento_lancamentos;
create policy "faturamento_lancamentos_select_coord" on faturamento_lancamentos for select to authenticated using (acesso_faturamento());
create policy "faturamento_lancamentos_insert_coord" on faturamento_lancamentos for insert to authenticated with check (acesso_faturamento());
create policy "faturamento_lancamentos_update_coord" on faturamento_lancamentos for update to authenticated using (acesso_faturamento()) with check (acesso_faturamento());
create policy "faturamento_lancamentos_delete_coord" on faturamento_lancamentos for delete to authenticated using (acesso_faturamento());

notify pgrst, 'reload schema';
