import unittest
from worker.reports import contract_history


class HistoryReportTests(unittest.TestCase):
    def test_full_contract_history_preserves_seller_status_and_cancellation(self):
        result=contract_history({"ID CONTRATO":1005,"ID CLIENTE":42,"RAZAO SOCIAL/NOME":"CLIENTE EXEMPLO LTDA",
            "PLANO DE VENDA":"LINK IP CLIENTE EXEMPLO","VALOR CONTRATO":"3.000,00","STATUS CONTRATO":"Inativo",
            "STATUS ACESSO":"Desativado","VENDEDOR":17,"VENDEDOR 2":"VENDEDOR EXEMPLO",
            "DATA ATIVAAAO":"04/11/2026","DATA RENOVAAAO":"06/10/2027","DATA DE EXPIRAAAO":"06/10/2027",
            "DATA DO CANCELAMENTO":"20/11/2026","MOTIVO":"SOLICITADO"})
        self.assertEqual(result["contract_key"],"1005")
        self.assertEqual(result["client_key"],"42")
        self.assertEqual(result["total"],"3000.0000")
        self.assertEqual(result["seller"],"VENDEDOR EXEMPLO")
        self.assertEqual(result["activated"],"2026-11-04")
        self.assertEqual(result["cancelled"],"2026-11-20")


if __name__ == '__main__':
    unittest.main()
