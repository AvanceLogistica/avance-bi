-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- avancelogisticaintegrada@gmail.com: só Recursos Humanos, Manutenção de Carreta, Organograma e Emissão de O.S.
-- Perfil Administrativo (Emissão de O.S + Organograma) + telas extras RH e Manutenção de Carreta.

-- quem tem a Manutenção de Carreta como tela extra lê/grava o controle de carretas e o pátio
create or replace function acesso_oficina()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','operacional','oficina')) or tem_pagina_extra('manutencao');
$$;
create or replace function acesso_patio()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','operacional','oficina','patio')) or tem_pagina_extra('manutencao');
$$;
create or replace function acesso_rh()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','rh')) or tem_pagina_extra('rh');
$$;
create or replace function acesso_organograma()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','rh','administrativo')) or tem_pagina_extra('rh');
$$;

update user_roles set papel = 'administrativo'
where lower(email) = lower('avancelogisticaintegrada@gmail.com') and papel <> 'diretor';

insert into user_paginas_extra (user_id, email, paginas)
select id, email, array['rh','manutencao'] from auth.users where lower(email) = lower('avancelogisticaintegrada@gmail.com')
on conflict (user_id) do update set paginas = array['rh','manutencao'], atualizado_em = now();

notify pgrst, 'reload schema';

select u.email, coalesce(r.papel, 'sem perfil') as perfil, coalesce(x.paginas, '{}') as telas_extras
from auth.users u left join user_roles r on r.user_id = u.id left join user_paginas_extra x on x.user_id = u.id
where lower(u.email) = lower('avancelogisticaintegrada@gmail.com');
