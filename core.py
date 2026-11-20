"""作者：Wangyuan；日期：2026-10-29；职责：目录清理与重复过滤。"""
from spatial.security import sanitize_tool

def run(payload):
    if not isinstance(payload,dict):raise TypeError('输入须对象')
    rows=payload.get('tools',[])
    if not isinstance(rows,list):raise TypeError('tools须数组')
    out=[];seen=set()
    for row in rows:
        tool=sanitize_tool(row)
        if tool and tool['id'] not in seen:out.append(tool);seen.add(tool['id'])
    return {'tools':out,'launch_enabled':False,'camera_enabled':False}
