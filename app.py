"""作者：Wangyuan；日期：2026-10-29；职责：合成空间目录，所有工具启动回调关闭。"""
import os,secrets
from flask import Flask,redirect,jsonify
from spatial.blueprint import create_ai_live_blueprint
TOOLS=[{'id':'synthetic-notes','name':'合成笔记索引','category':'知识','summary':'浏览合成笔记目录。','kind':'web','access':'public'},{'id':'synthetic-media','name':'合成媒体实验','category':'媒体','summary':'展示合成媒体处理能力。','kind':'web','access':'public'}]
app=Flask(__name__);app.config.update(AI_LIVE_SECRET=secrets.token_hex(32),AI_LIVE_ENABLED=True,AI_LIVE_WEBSOCKET_ENABLED=False)
app.register_blueprint(create_ai_live_blueprint(catalog_provider=lambda:TOOLS,launch_callback=None))
@app.get('/')
def index():return redirect('/tools/ai_live_interaction/')
@app.get('/healthz')
def health():return jsonify(ok=True)
if __name__=='__main__':app.run(host=os.environ.get('HOST','127.0.0.1'),port=int(os.environ.get('PORT','8092')),debug=False)
