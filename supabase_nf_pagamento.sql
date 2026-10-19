-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Baixa de pagamento das NF emitidas (lead time emissão -> pagamento).
alter table nf_emitidas add column if not exists data_pagamento date;
notify pgrst, 'reload schema';
