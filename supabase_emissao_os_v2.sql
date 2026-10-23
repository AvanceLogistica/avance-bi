-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Pré O.S e O.S como lançamentos separados: a O.S emitida aponta para a Pré O.S de origem (pre_id);
-- a Pré O.S fica com status "validada".
alter table manutencao_os add column if not exists pre_id uuid;
notify pgrst, 'reload schema';
