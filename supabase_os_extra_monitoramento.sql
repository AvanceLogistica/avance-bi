-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Libera a Emissão de O.S (como o Administrativo) para avance.monitoramento@gmail.com, mantendo o perfil dele.
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

-- quem tem "emissaonf" como tela extra entra nas O.S como o Administrativo
create or replace function acesso_os()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','operacional','coordenacao','manutencao','oficina','administrativo','preos'))
      or tem_pagina_extra('emissaonf');
$$;
create or replace function gestao_tabela_os()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','coordenacao','administrativo'))
      or tem_pagina_extra('emissaonf');
$$;

insert into user_paginas_extra (user_id, email, paginas)
select id, email, array['emissaonf'] from auth.users where lower(email) = lower('avance.monitoramento@gmail.com')
on conflict (user_id) do update set paginas = (select array(select distinct unnest(user_paginas_extra.paginas || array['emissaonf']))), atualizado_em = now();

notify pgrst, 'reload schema';

select u.email, coalesce(r.papel, 'sem perfil') as perfil, coalesce(x.paginas, '{}') as telas_extras
from auth.users u left join user_roles r on r.user_id = u.id left join user_paginas_extra x on x.user_id = u.id
where lower(u.email) = lower('avance.monitoramento@gmail.com');
