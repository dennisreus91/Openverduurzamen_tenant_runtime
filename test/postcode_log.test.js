// test/postcode_log.test.js
//
// Elke ingevulde postcode in onze eigen opslag, voor de conversie per postcode
// (wens Dennis, 20 november 2026). Zie lib/postcode_log.js.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postcodes-"));
process.env.ORDERS_DATA_DIR = dir;
const { normaliseerPostcode, legPostcodeVast, leesPostcodes, postcodeOverzicht, alsCsv } = await import("../lib/postcode_log.js");

test("postcodes worden genormaliseerd, rommel niet vastgelegd", () => {
  assert.equal(normaliseerPostcode(" 3131 kz "), "3131KZ");
  assert.equal(normaliseerPostcode("0131KZ"), null);
  assert.equal(normaliseerPostcode("abc"), null);
  assert.equal(legPostcodeVast({ postcode: "abc", gebeurtenis: "opgezocht" }), false);
  assert.equal(legPostcodeVast({ postcode: "3131KZ", gebeurtenis: "verzonnen" }), false);
});

test("opzoeken, downloaden en aanvragen geven de conversie per postcode", () => {
  for (let i = 0; i < 4; i++) legPostcodeVast({ postcode: "3131KZ", gebeurtenis: "opgezocht", tenant: "t" });
  legPostcodeVast({ postcode: "3131kz", gebeurtenis: "rapport_gedownload", tenant: "t" });
  legPostcodeVast({ postcode: "3131KZ", gebeurtenis: "volledig_aangevraagd", tenant: "t" });
  legPostcodeVast({ postcode: "3132AB", gebeurtenis: "opgezocht", tenant: "t" });
  fs.appendFileSync(path.join(dir, "postcode_log.jsonl"), "{kapot\n");

  const rijen = postcodeOverzicht(leesPostcodes());
  assert.equal(rijen[0].postcode, "3131KZ");
  assert.equal(rijen[0].opgezocht, 4);
  assert.equal(rijen[0].conversie, 0.5);
  assert.equal(rijen[1].conversie, 0);

  const pc4 = postcodeOverzicht(leesPostcodes(), { niveau: "pc4" });
  assert.deepEqual(pc4.map((r) => r.postcode), ["3131", "3132"]);
  assert.match(alsCsv(rijen), /^postcode;opgezocht;/);
  // Geen huisnummer, naam of e-mail in de opslag.
  const ruw = fs.readFileSync(path.join(dir, "postcode_log.jsonl"), "utf-8");
  assert.doesNotMatch(ruw, /@|housenumber/);
});

test("de postcode gaat ook naar de centrale database, met alleen postcode en gebeurtenis", async (t) => {
  const { meldPostcode } = await import("../lib/centraal.js");
  assert.deepEqual(await meldPostcode("3131KZ", "opgezocht"), { gemeld: false, reden: "centraal_uit" });

  const http = await import("node:http");
  const ontvangen = [];
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      ontvangen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end('{"id":7}');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  process.env.CENTRAAL_API_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.CENTRAAL_API_SLEUTEL = "x".repeat(40);
  t.after(() => { delete process.env.CENTRAAL_API_URL; delete process.env.CENTRAAL_API_SLEUTEL; });

  assert.deepEqual(await meldPostcode("3131KZ", "rapport_gedownload"), { gemeld: true, id: 7 });
  assert.equal(ontvangen[0].url, "/api/v1/postcodes");
  assert.deepEqual(ontvangen[0].body, { postcode: "3131KZ", gebeurtenis: "rapport_gedownload" });
});
