-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Telas extras por usuário (somam às do perfil dele) + Infrações/Sinistro para avancelogistica.coord@gmail.com.
create table if not exists user_paginas_extra (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  paginas text[] not null default '{}',
  atualizado_em timestamptz not null default now()
);
alter table user_paginas_extra enable row level security;
drop policy if exists "user_paginas_extra_ler" on user_paginas_extra;
create policy "user_paginas_extra_ler" on user_paginas_extra for select to authenticated using (user_id = auth.uid() or eh_diretor());
drop policy if exists "user_paginas_extra_diretor" on user_paginas_extra;
create policy "user_paginas_extra_diretor" on user_paginas_extra for all to authenticated using (eh_diretor()) with check (eh_diretor());

create or replace function tem_pagina_extra(p text)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_paginas_extra where user_id = auth.uid() and p = any(paginas));
$$;

-- Infrações (leitura) e Sinistro (registro) para quem tem a tela como extra
drop policy if exists "infracoes_lancamentos_select_extra" on infracoes_lancamentos;
create policy "infracoes_lancamentos_select_extra" on infracoes_lancamentos for select to authenticated using (tem_pagina_extra('infracoes'));
drop policy if exists "sinistros_extra" on sinistros;
create policy "sinistros_extra" on sinistros for all to authenticated using (tem_pagina_extra('infracoes')) with check (tem_pagina_extra('infracoes'));
-- a lista de placas do Sinistro vem do cadastro da frota
drop policy if exists "frota_veiculos_select_extra" on frota_veiculos;
create policy "frota_veiculos_select_extra" on frota_veiculos for select to authenticated using (tem_pagina_extra('infracoes'));

-- libera a tela Infrações para avancelogistica.coord@gmail.com (mantém o perfil que ele já tem)
insert into user_paginas_extra (user_id, email, paginas)
select id, email, array['infracoes'] from auth.users where lower(email) = lower('avancelogistica.coord@gmail.com')
on conflict (user_id) do update set paginas = (select array(select distinct unnest(user_paginas_extra.paginas || array['infracoes']))), atualizado_em = now();

notify pgrst, 'reload schema';

select u.email, coalesce(r.papel, 'sem perfil') as perfil, coalesce(x.paginas, '{}') as telas_extras
from auth.users u left join user_roles r on r.user_id = u.id left join user_paginas_extra x on x.user_id = u.id
where lower(u.email) = lower('avancelogistica.coord@gmail.com');
