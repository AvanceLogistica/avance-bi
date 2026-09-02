-- Rode isto UMA VEZ no SQL Editor do Supabase (https://app.supabase.com > seu projeto > SQL Editor)
-- Acrescenta 2 colunas novas na tabela "contas_pagar" que já existe, sem apagar nada do que já
-- estiver lá: "servico" (descrição específica do serviço, ex: "COMPRAS DE PEÇAS") e "parcela"
-- (ex: "1/3"), usadas pela nova importação da planilha "Contas_a_Pagar_Dashboard".

alter table contas_pagar add column if not exists servico text;
alter table contas_pagar add column if not exists parcela text;
