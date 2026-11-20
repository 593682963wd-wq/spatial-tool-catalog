# 空间工具目录与键鼠交互

保留原Three.js空间展示、键鼠/指针状态机、多屏协议、安全令牌、目录预览；合成目录替换真实注册表，启动回调关闭。

## 使用

Python 3.11+。在本目录建立独立虚拟环境：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python cli.py example.json
.venv/bin/python -m unittest discover -v
```

`example.json`从零编写，仅含虚构输入。可以显式提供自己的同结构JSON文件。输出默认为终端；`--output result.json`使用独占创建，避免覆盖已有结果。CLI失败退出码2。

## 数据与边界

不发现本机账号、不读取环境中的模型密钥、不发送消息、不请求远端数据。只处理调用方明确传入的文件、记录或参数。合成示例不代表任何实际业务结果。摄像头/手势模型未包含也不会请求授权；真实工具启动完全关闭；仓库随附Three.js 0.185.1 的两个浏览器模块，与上游发布包逐字节一致。两者保留上游版权和 [MIT 许可证](static/vendor/three/LICENSE)。Web预览：`PORT=8092 python3 app.py`。

## 发布状态

本项目源码采用 MIT 许可证，见 LICENSE。依赖按各自上游许可使用，安装的依赖/模型/字体/媒体不随此源码目录分发。

## 2026-11-08 协作修订

- 工具输入先验证对象类型，内置description字段正确显示。
- 预览请求以代次保护，旧响应不能覆盖新选择。
- 输入框和可编辑目标不触发场景全局快捷键。
- 来源身份长度符合64字符合同；快照更新同步渲染器场景。

集合根目录 `verify_release.py --project personal-spatial-tool-catalog` 可复跑合成测试和首次使用示例；本轮以集合验证报告为准。

Docker默认只向 `127.0.0.1` 发布端口；扩大监听需在显式环境中设置 `BIND_ADDRESS`，并按真实入口设置 `PUBLIC_ORIGIN` 和访问保护。脚本不自动提供认证。

页面基础布局样式放在同源CSS中，遵循现有CSP，无须允许内联样式。真实Chrome无窗口验证覆盖进入、键盘切换、摘要预览及手机尺寸；未申请摄像头权限。
