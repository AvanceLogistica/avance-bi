-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Motivo da entrega não realizada (Programação diária de entregas).
alter table entregas_programacao add column if not exists motivo text;
alter table entregas_programacao add column if not exists motivo_obs text;
notify pgrst, 'reload schema';
