-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Cria o perfil "monitoramento" (só enxerga a Programação diária de entregas) e a tabela onde ficam
-- os lançamentos do dia (planejado x realizado), com histórico.

alter table user_roles drop constraint if exists user_roles_papel_check;
alter table user_roles add constraint user_roles_papel_check check (papel in ('diretor','operacional','lider','monitoramento'));

create or replace function acesso_programacao()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','operacional','monitoramento'));
$$;

create table if not exists entregas_programacao (
  id uuid primary key default gen_random_uuid(),
  data date not null,
  veiculo_id uuid references frota_veiculos(id) on delete set null,
  frota text not null,            -- "07 GCV3D62" (fica gravado mesmo se o cadastro mudar)
  motorista text,
  cliente text,
  transportadora text,
  servico text not null default 'ENTREGA',
  horario text,                   -- "07:00"
  nf text,                        -- só números
  planejado boolean not null default true,   -- false = entrega extra, fora do plano
  situacao text not null default 'pendente', -- pendente | realizada | nao_realizada
  hora_real text,
  criado_por text,
  atualizado_por text,
  atualizado_em timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists entregas_programacao_data_idx on entregas_programacao (data);

alter table entregas_programacao enable row level security;
drop policy if exists "prog_select" on entregas_programacao;
drop policy if exists "prog_insert" on entregas_programacao;
drop policy if exists "prog_update" on entregas_programacao;
drop policy if exists "prog_delete" on entregas_programacao;
create policy "prog_select" on entregas_programacao for select to authenticated using (acesso_programacao());
create policy "prog_insert" on entregas_programacao for insert to authenticated with check (acesso_programacao());
create policy "prog_update" on entregas_programacao for update to authenticated using (acesso_programacao()) with check (acesso_programacao());
create policy "prog_delete" on entregas_programacao for delete to authenticated using (acesso_programacao());

-- O monitoramento precisa LER a lista das 43 frotas e o motorista do dia (não altera nada da frota)
drop policy if exists "frota_veiculos_select_monitoramento" on frota_veiculos;
drop policy if exists "frota_status_select_monitoramento" on frota_status;
create policy "frota_veiculos_select_monitoramento" on frota_veiculos for select to authenticated using (acesso_programacao());
create policy "frota_status_select_monitoramento" on frota_status for select to authenticated using (acesso_programacao());

notify pgrst, 'reload schema';
