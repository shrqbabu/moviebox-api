const dns = require("dns");
try { dns.setDefaultResultOrder("ipv4first"); } catch (_) {}
const { MovieBoxClient, HOST_POOL } = require("./core/client");
const { MovieBoxSession, parseJwtClaims } = require("./core/session");
const crypto = require("./core/crypto");

module.exports = {
  MovieBoxClient,
  MovieBoxSession,
  parseJwtClaims,
  HOST_POOL,
  crypto,
};
