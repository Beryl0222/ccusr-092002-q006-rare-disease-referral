import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
createApp().listen(port, "0.0.0.0", () => console.log(`协同转诊服务监听 ${port} 端口`));
