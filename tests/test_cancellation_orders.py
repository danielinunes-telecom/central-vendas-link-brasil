import unittest
from worker.reports import cancellation_order

class CancellationOrderTests(unittest.TestCase):
    def row(self,text,status="ENCERRADA"):
        return cancellation_order({"ID":"10","ID CONTRATO":"1005","ID CLIENTE":"20","CLIENTE":"ACME","ASSUNTO":"CANCELAMENTO","STATUS":status,"DESCRICAO":text,"DATA ABERTURA":"20/11/2026"})

    def test_closed_status_alone_is_not_confirmation(self):
        result=self.row("Cliente pediu informações")
        self.assertEqual(result["classification"],"pending")
        self.assertTrue(result["needs_review"])

    def test_explicit_reversal_wins(self):
        result=self.row("Cliente desistiu do cancelamento e permaneceu ativo")
        self.assertEqual(result["classification"],"reversed")
        self.assertFalse(result["needs_review"])

    def test_explicit_effective_cancellation(self):
        self.assertEqual(self.row("Contrato cancelado conforme confirmação do cliente")["classification"],"effective")

if __name__ == '__main__': unittest.main()
