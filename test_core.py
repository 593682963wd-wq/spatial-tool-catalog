import unittest,tempfile,json
from pathlib import Path
from core import run

class Tests(unittest.TestCase):
 def test_catalog(self):self.assertEqual(len(run(json.loads(Path('example.json').read_text()))['tools']),1)
 def test_empty(self):self.assertFalse(run({})['launch_enabled'])
 def test_invalid(self):
  with self.assertRaises(TypeError):run({'tools':5})
 def test_routes(self):
  from app import app
  c=app.test_client();self.assertEqual(c.get('/tools/ai_live_interaction/').status_code,200);self.assertEqual(c.get('/tools/ai_live_interaction/api/tools').status_code,200)

if __name__=="__main__":unittest.main()
