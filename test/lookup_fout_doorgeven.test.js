// Stap 9.12 (26-11-2026): een fout van de report-api bij het opzoeken van het adres gaat met zijn status, code en keuzes door
// naar het formulier. Tot nu toe werd elke fout een 500, ook "kies een toevoeging" (29A of 29B): live gezien op WoonWijzerWinkel
// en Softbee. Het formulier toont bij kies_toevoeging een knop per toevoeging.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-lookupfout-"));
process.env.ORDERS_DATA_DIR = DATA_DIR;
const { createTenantApp } = await import("../index.js");

async function luister(handler) {
  const s = http.createServer(handler);
  s.keepAliveTimeout = 1;
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return s;
}
async function sluit(s) {
  s.closeAllConnections?.();
  await new Promise((r) => s.close(r));
}

async function metReportApi(t, status, body) {
  const api = await luister((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify(body));
    });
  });
  const oud = process.env.FULL_APP_LOOKUP_URL;
  process.env.FULL_APP_LOOKUP_URL = `http://127.0.0.1:${api.address().port}/api/mid/lookup`;
  const app = await luister(createTenantApp({ id: "testtenant", brand: { name: "Test" } }));
  t.after(async () => {
    process.env.FULL_APP_LOOKUP_URL = oud;
    await sluit(app);
    await sluit(api);
  });
  const res = await fetch(`http://127.0.0.1:${app.address().port}/api/mid/lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ postalcode: "2625ZD", housenumber: "29" }),
  });
  return { status: res.status, json: await res.json() };
}

test("kies een toevoeging: 404 met de code en de keuzes, geen 500", async (t) => {
  const { status, json } = await metReportApi(t, 404, {
    error: "Bij huisnummer 29 horen meerdere adressen: 29A, 29B. Kies het juiste adres en vul de toevoeging in (bijvoorbeeld A).",
    code: "kies_toevoeging",
    toevoegingen: ["A", "B"],
  });
  assert.equal(status, 404);
  assert.equal(json.code, "kies_toevoeging");
  assert.deepEqual(json.toevoegingen, ["A", "B"]);
  assert.match(json.error, /meerdere adressen/);
});

test("adres niet gevonden blijft een 404", async (t) => {
  const { status, json } = await metReportApi(t, 404, { error: "Adres niet gevonden.", code: "address_not_found_no_bag_id" });
  assert.equal(status, 404);
  assert.equal(json.code, "address_not_found_no_bag_id");
});

test("een fout van de report-api zelf blijft een 500", async (t) => {
  const { status } = await metReportApi(t, 502, { error: "upstream" });
  assert.equal(status, 500);
});
