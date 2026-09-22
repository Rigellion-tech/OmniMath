// Preload for offline verification runs. Mocked fetch remains usable; real network
// connections outside loopback fail even if a developer environment has API keys.
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof options === "object" ? options.host : typeof args[1] === "string" ? args[1] : "localhost";
  const path = typeof options === "object" ? options.path : typeof options === "string" ? options : null;
  if (!path && host && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) throw new Error(`Offline tests blocked external network host: ${host}`);
  return originalConnect.apply(this, args);
};
syncBuiltinESMExports();
