-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Campo "Balsa" nas NF emitidas e abertura opcional nas balsas trazidas de NFs já emitidas.
alter table nf_emitidas add column if not exists balsa text;
alter table balsas_viagens alter column data_abertura drop not null;
notify pgrst, 'reload schema';
