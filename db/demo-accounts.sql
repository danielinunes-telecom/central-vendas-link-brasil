insert into comercial.accounts(email,name,role,seller_key) values
('admin@linkbrasil.test','Administração','admin',null),
('gestao@linkbrasil.test','Gestão Comercial','manager',null),
('cayo@linkbrasil.test','Cayo Cesar Cacure','seller','cayo')
on conflict(email) do nothing;

