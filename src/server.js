import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
// 生产启动默认执行一次重启恢复；可用 STARTUP_RECOVERY=0 关闭。
const recoverOnStart = (process.env.STARTUP_RECOVERY ?? "1") !== "0";
createApp(undefined, { recoverOnStart }).listen(port, "0.0.0.0", () => console.log(`协同转诊服务监听 ${port} 端口`));
