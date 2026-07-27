"use strict";

const config = require("./config");
const { buildServer } = require("./app");

const { server } = buildServer();

server.listen(config.port, () => {
  const auth = [config.google.enabled && "Google", config.discord.enabled && "Discord"].filter(Boolean);
  console.log(`\n  WikiGuessr running at ${config.baseUrl}`);
  console.log(`      Port ${config.port} · ${config.env} mode`);
  console.log(`      OAuth: ${auth.length ? auth.join(", ") : "none configured (guests only)"}`);
  console.log(`      Ads:   ${config.adsense.enabled ? config.adsense.client : "disabled"}\n`);
});
