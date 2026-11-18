"""Queue lifecycle checks without production credentials."""
import unittest
from threading import Event
from unittest.mock import patch

from worker.run import configuration_error, run_queue


class LifecycleTests(unittest.TestCase):
    def test_hosted_worker_reports_missing_environment_without_values(self):
        with patch.dict('os.environ', {}, clear=True):
            self.assertEqual(configuration_error('pgmq'),
                'Configure as variáveis do importador: DATABASE_URL, SUPABASE_URL, SUPABASE_SERVER_KEY')

    def test_local_worker_does_not_require_storage_credentials(self):
        with patch.dict('os.environ', {'DATABASE_URL':'local-test','IMPORT_LOCAL_PATH':'local-files'}, clear=True):
            self.assertIsNone(configuration_error('local'))

    def test_shutdown_finishes_current_job_and_claims_no_next_job(self):
        stopping = Event()
        completed = []
        def processing(conn, mode):
            stopping.set()  # SIGTERM while the import is in progress.
            completed.append('current job committed')
            return True
        with patch('worker.run.poll', side_effect=processing) as poll:
            run_queue(object(), 'pgmq', False, stopping)
            self.assertEqual(poll.call_count, 1)
        self.assertEqual(completed, ['current job committed'])

    def test_once_processes_only_one_poll(self):
        with patch('worker.run.poll', return_value=True) as poll:
            run_queue(object(), 'pgmq', True, Event())
            self.assertEqual(poll.call_count, 1)

    def test_shutdown_before_loop_does_not_consume_message(self):
        stopping = Event()
        stopping.set()
        with patch('worker.run.poll') as poll:
            run_queue(object(), 'pgmq', False, stopping)
            poll.assert_not_called()


if __name__ == '__main__':
    unittest.main()
