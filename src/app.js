import { createServer } from "node:http";
import { openDatabase } from "./database.js";

export function createApp(databasePath) {
  return createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    const database = openDatabase(databasePath);
    try {
      database.prepare("SELECT 1").get();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ status: "ok", service: "罕见病协同转诊网络" }));
    } finally {
      database.close();
    }
  });
}
