-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Perfil "personalizado": a pessoa enxerga SÓ as telas extras liberadas para ela (user_paginas_extra).
-- avance.monitoramento@gmail.com: só Quadro de Pessoal, Organograma e Hora Extra.
alter table user_roles drop constraint if exists user_roles_papel_check;
alter table user_roles add constraint user_roles_papel_check check (papel in ('diretor','operacional','lider','monitoramento','coordenacao','manutencao','rh','oficina','administrativo','preos','frotaoficina','patio','personalizado'));

-- dados de cada tela para quem a recebeu como extra
create or replace function acesso_organograma()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','rh','administrativo')) or tem_pagina_extra('rh') or tem_pagina_extra('organograma');
$$;
drop policy if exists "quadro_pessoal_acesso" on quadro_pessoal;
create policy "quadro_pessoal_acesso" on quadro_pessoal for all to authenticated
  using (eh_equipe_interna() or acesso_rh() or tem_pagina_extra('quadro')) with check (eh_equipe_interna() or acesso_rh() or tem_pagina_extra('quadro'));
drop policy if exists "horaextra_lancamentos_select_extra" on horaextra_lancamentos;
create policy "horaextra_lancamentos_select_extra" on horaextra_lancamentos for select to authenticated using (tem_pagina_extra('horaextra'));

update user_roles set papel = 'personalizado'
where lower(email) = lower('avance.monitoramento@gmail.com') and papel <> 'diretor';
insert into user_roles (user_id, email, papel)
select id, email, 'personalizado' from auth.users where lower(email) = lower('avance.monitoramento@gmail.com')
on conflict (user_id) do nothing;
insert into user_paginas_extra (user_id, email, paginas)
select id, email, array['quadro','organograma','horaextra'] from auth.users where lower(email) = lower('avance.monitoramento@gmail.com')
on conflict (user_id) do update set paginas = array['quadro','organograma','horaextra'], atualizado_em = now();

notify pgrst, 'reload schema';

select u.email, coalesce(r.papel, 'sem perfil') as perfil, coalesce(x.paginas, '{}') as telas
from auth.users u left join user_roles r on r.user_id = u.id left join user_paginas_extra x on x.user_id = u.id
where lower(u.email) = lower('avance.monitoramento@gmail.com');
