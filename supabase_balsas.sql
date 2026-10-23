-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Controle de balsas da Logística Reversa (aba NF Emitidas): abertura, fechamento, documento do cliente,
-- NF ligada (nf_id) e recebimento (pela baixa de pagamento da NF).

create table if not exists balsas_viagens (
  id uuid primary key default gen_random_uuid(),
  atividade text not null,            -- lr_sw | lr_carreteira
  balsa text not null,
  numero text,
  data_abertura date not null,
  data_fechamento date,
  data_documento date,
  nf_id uuid references nf_emitidas(id) on delete set null,
  obs text,
  criado_por text,
  atualizado_por text,
  atualizado_em timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table balsas_viagens enable row level security;
drop policy if exists "balsas_viagens_all" on balsas_viagens;
create policy "balsas_viagens_all" on balsas_viagens for all to authenticated using (acesso_faturamento()) with check (acesso_faturamento());

notify pgrst, 'reload schema';
