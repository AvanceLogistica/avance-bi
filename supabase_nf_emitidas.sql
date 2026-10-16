-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Tabela das NF emitidas por atividade (aba "NF Emitidas" da tela Emissão de NF).
-- Acesso: Diretor, Operacional e Coordenação (mesma regra do faturamento).

create or replace function acesso_faturamento()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and papel in ('diretor','operacional','coordenacao'));
$$;

create table if not exists nf_emitidas (
  id uuid primary key default gen_random_uuid(),
  atividade text not null,      -- lr_sw | lr_carreteira | desatrelamento | puxadas | outros | manutencao
  sentido text,                 -- sobe | desce (só nas logísticas reversas)
  numero text,
  nf text not null,
  valor numeric not null,
  data_emissao date not null,
  obs text,
  criado_por text,
  atualizado_por text,
  atualizado_em timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists nf_emitidas_data_idx on nf_emitidas (data_emissao);

alter table nf_emitidas enable row level security;
drop policy if exists "nf_emitidas_all" on nf_emitidas;
create policy "nf_emitidas_all" on nf_emitidas for all to authenticated using (acesso_faturamento()) with check (acesso_faturamento());

notify pgrst, 'reload schema';
