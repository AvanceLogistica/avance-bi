-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- 1) Campo "Balsa" nas NF emitidas e abertura opcional nas balsas trazidas de NFs já emitidas.
alter table nf_emitidas add column if not exists balsa text;
alter table balsas_viagens alter column data_abertura drop not null;

-- 2) A baixa do recebimento (data_pagamento) só pode ser dada ou desfeita pela Diretoria.
create or replace function nf_baixa_so_diretor() returns trigger language plpgsql as $$
begin
  if (tg_op = 'INSERT' and new.data_pagamento is not null and not eh_diretor())
     or (tg_op = 'UPDATE' and new.data_pagamento is distinct from old.data_pagamento and not eh_diretor()) then
    raise exception 'A baixa do recebimento é feita pela Diretoria';
  end if;
  return new;
end $$;
drop trigger if exists nf_baixa_so_diretor on nf_emitidas;
create trigger nf_baixa_so_diretor before insert or update on nf_emitidas
  for each row execute function nf_baixa_so_diretor();

notify pgrst, 'reload schema';
