-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Retorno da O.S: data em que a Combitrans devolveu assinada e a NF emitida para ela.
alter table manutencao_os add column if not exists assinada_em date;
alter table manutencao_os add column if not exists nf_numero text;
alter table manutencao_os add column if not exists nf_id uuid;
alter table manutencao_os add column if not exists nf_em date;
notify pgrst, 'reload schema';
