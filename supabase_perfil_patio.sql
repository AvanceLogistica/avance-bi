-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Perfil "patio": só o mapa do pátio (Manutenção de Carreta > Pátio). Libera para silvathiago876@gmail.com.
alter table user_roles drop constraint if exists user_roles_papel_check;
alter table user_roles add constraint user_roles_papel_check check (papel in ('diretor','operacional','lider','monitoramento','coordenacao','manutencao','rh','oficina','administrativo','preos','frotaoficina','patio'));

create or replace function acesso_patio()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','operacional','oficina','patio'));
$$;

create table if not exists patio_layout (
  data date primary key,
  posicoes jsonb not null default '{}'::jsonb,
  atualizado_por text,
  atualizado_em timestamptz not null default now()
);
alter table patio_layout enable row level security;
drop policy if exists "patio_layout_all" on patio_layout;
create policy "patio_layout_all" on patio_layout for all to authenticated using (acesso_patio()) with check (acesso_patio());

-- o perfil Pátio só lê a lista de carretas e a fila do pátio
drop policy if exists "os_carretas_select_patio" on os_carretas;
create policy "os_carretas_select_patio" on os_carretas for select to authenticated using (acesso_patio());
drop policy if exists "carretas_fila_select_patio" on carretas_fila;
create policy "carretas_fila_select_patio" on carretas_fila for select to authenticated using (acesso_patio());

update auth.users set email_confirmed_at = now()
where lower(email) = lower('silvathiago876@gmail.com') and email_confirmed_at is null;

insert into user_roles (user_id, email, papel)
select id, email, 'patio' from auth.users where lower(email) = lower('silvathiago876@gmail.com')
on conflict (user_id) do update set papel = excluded.papel;

notify pgrst, 'reload schema';

select u.email, u.email_confirmed_at is not null as email_confirmado, coalesce(r.papel, 'sem perfil') as perfil
from auth.users u left join user_roles r on r.user_id = u.id
where lower(u.email) = lower('silvathiago876@gmail.com');
