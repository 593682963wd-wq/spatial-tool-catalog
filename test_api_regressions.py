import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from core import run

class ApiRegressions(unittest.TestCase):
    def test_null_tool_cli_controlled(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'tools.json';path.write_text('{"tools":[null]}')
            result=subprocess.run([sys.executable,'-B','cli.py',str(path)],capture_output=True,text=True)
        self.assertEqual(result.returncode,2,result.stderr)
        self.assertNotIn('Traceback',result.stderr)
    def test_builtin_summaries_retained(self):
        from app import app,TOOLS
        result=run({'tools':TOOLS})
        self.assertTrue(all(t['summary']!='暂无简介' for t in result['tools']))
        client=app.test_client();data=client.get('/tools/ai_live_interaction/api/tools').get_json()
        self.assertIn('浏览合成笔记目录。',json.dumps(data,ensure_ascii=False))
    def ui(self,case):
        node=os.environ.get('NODE_BIN') or 'node'
        result=subprocess.run([node,'test-ui-api.mjs',case],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
    def test_preview_stale_response_and_close(self):self.ui('race')
    def test_keyboard_input_keeps_own_keys(self):self.ui('keyboard')
    def test_display_source_id_protocol_bounds(self):self.ui('source_id')
    def test_snapshot_applies_renderer_world(self):self.ui('snapshot')

class LaunchRegressions(unittest.TestCase):
    def test_synthetic_launch_success_and_stale_response(self) -> None:
        import os,shutil,subprocess
        result=subprocess.run([os.environ.get('NODE_BIN') or shutil.which('node'),'test-ui-api.mjs','launch'],capture_output=True,text=True,timeout=20)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
