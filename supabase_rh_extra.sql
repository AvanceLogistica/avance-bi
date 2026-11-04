-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Recursos Humanos como "tela extra": a pessoa mantém o perfil dela e ganha a aba RH.
-- Devolve o perfil Operacional (com Manutenção de Carreta) para avancelogisticaintegrada@gmail.com + aba RH.

create or replace function acesso_rh()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','rh')) or tem_pagina_extra('rh');
$$;

-- a ficha usa a base de colaboradores do Organograma
create or replace function acesso_organograma()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','rh','administrativo')) or tem_pagina_extra('rh');
$$;

update user_roles set papel = 'operacional'
where lower(email) = lower('avancelogisticaintegrada@gmail.com') and papel = 'rh';

insert into user_paginas_extra (user_id, email, paginas)
select id, email, array['rh'] from auth.users where lower(email) = lower('avancelogisticaintegrada@gmail.com')
on conflict (user_id) do update set paginas = (select array(select distinct unnest(user_paginas_extra.paginas || array['rh']))), atualizado_em = now();

notify pgrst, 'reload schema';

select u.email, coalesce(r.papel, 'sem perfil') as perfil, coalesce(x.paginas, '{}') as telas_extras
from auth.users u left join user_roles r on r.user_id = u.id left join user_paginas_extra x on x.user_id = u.id
where lower(u.email) = lower('avancelogisticaintegrada@gmail.com');
