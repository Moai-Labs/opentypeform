// Entry point: create the app and listen.
"use strict";

const http = require("node:http");
const { createApp } = require("./lib/app");

const port = Number(process.env.PORT) || 3000;
const app = createApp();

http.createServer(app.handler).listen(port, () => {
  console.log(`listening on ${port}`);
});
