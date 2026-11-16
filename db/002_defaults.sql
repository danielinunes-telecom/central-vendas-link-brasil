begin;
insert into comercial.sellers(seller_key,name,team) values
('fabiana','Fabiana Basílio de Queiroz','Carteira'),
('luiz','Luiz Henrique Fontanetti Roldi','Carteira'),
('odeyr','Odeyr Ramos Filho','Carteira'),
('pamela','Pamela Monan Alexandrino Ferraz','Carteira'),
('thiago','Thiago Aparecido de Brito','Hunter'),
('cayo','Cayo Cesar Cacure','Hunter'),
('adriano','Adriano de Souza Solera','Hunter'),
('douglas','Douglas Rogerio dos Santos Colato','Carteira'),
('flavio','Flávio Panini','Carteira'),
('marcos','Marcos Massa','Carteira'),
('natalia','Natália Ferreira Vicente','Internas'),
('gustavo','Gustavo Bucalon','Carteira'),
('flavio-novato','Flávio - Novato','Carteira'),
('daniel-novato','Daniel - Novato','Carteira'),
('julio-novato','Julio - Novato','Carteira'),
('andreza-novato','Andreza - Novato','Carteira'),
('thais','Thais Marchetti','Carteira'),
('ygor','Ygor Mello','Carteira'),
('vinicios','Vinicios Bardella','Carteira');

insert into comercial.targets(seller_key,effective_month,amount)
select seller_key,date '2026-11-01',
  case team when 'Hunter' then 10000 when 'Internas' then 5000 else 7000 end
from comercial.sellers;

insert into comercial.product_rates(product,effective_month,rate)
select product,date '2026-11-01',rate
from (values ('OBRA',.03),('CDNTV',1),('MITIGAÇÃO',1),('LINK',.25),
  ('TRANSPORTE',.25),('PNI',.25),('GLOBAL CROSS',.25)) as t(product,rate);

insert into comercial.settings(setting,value) values
('aliases','{
  "FABIANA QUEIROZ":"fabiana", "LUIZ HENRIQUE ROLDI":"luiz",
  "PAMELA MONAN":"pamela", "ADRIANO SOLERA":"adriano",
  "FLAVIO CESAR PANINI":"flavio", "GUSTAVO PELOI BUCALON":"gustavo",
  "THAIS MARCHETI":"thais", "THAIS MARCHETTI ARAUJO":"thais",
  "YGOR":"ygor", "YGOR DE SOUSA MELLO":"ygor", "VINICIOS CONSONI BARDELLA":"vinicios"
}'),
('visit_rules','{"visit":["VISITA","VISITAS"],"prospect":["PROSPECÇÃO","PROSPECÇÕES"]}'),
('reversal_types','[]'),
('sales_doc_types','[]'),
('expense_limits','{"meal":40,"lodging":180}'),
('band_threshold','80'),
('plan_products','{}'),
('contract_clients','{}'),
('band_links','{}');
commit;
