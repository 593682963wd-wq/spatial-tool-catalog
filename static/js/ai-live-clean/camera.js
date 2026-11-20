// 禁用适配器保留交互层契约；任何方法均不访问浏览器媒体或模型接口。
export class CameraController {
 constructor(options){this.options=options;this.stream=null;this.video=options.video;this.inferenceFps=0;}
 capability(){return {ok:false,reason:"本发行版仅提供键鼠与触屏交互。"};}
 async start(){this.options.onStatus?.({state:"unavailable",message:this.capability().reason});return false;}
 stop(){this.stream=null;}
 setInferenceFps(value){this.inferenceFps=0;return false;}
 simulateModelFailure(){this.options.onStatus?.({state:"unavailable",message:this.capability().reason});return false;}
}
