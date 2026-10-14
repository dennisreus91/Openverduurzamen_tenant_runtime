// test/gedeelde_assets.test.js
//
// Een middel dat elke tenant hetzelfde hoort te hebben, komt uit de runtime.
//
// WAAROM
// contact_modal.js stond in vier kopieën die uit elkaar waren gelopen: Softbee
// had een focus-trap die de andere drie misten, De Energie Raadgever had de
// adviesmodus, en het terugvaladres in de foutmelding stond overal anders
// hardgecodeerd. Een verbetering op één plek bereikte de rest nooit.
//
// De overstap moet er één voor één kunnen, dus de eigen kopie van een tenant
// wint nog steeds. Die volgorde is het hele punt van deze test: draai hem om en
// een tenant die bewust afwijkt wordt stilletjes overschreven.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createTenantApp } from "../index.js";

/** Een tenant met een eigen public-map; `eigenAsset` zet er een kopie in. */
async function tenant(t, { eigenAsset = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-assets-"));
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  if (eigenAsset !== null) {
    fs.writeFileSync(path.join(dir, "assets", "contact_modal.js"), eigenAsset, "utf8");
  }
  const app = createTenantApp({ id: "testtenant", brand: { name: "Test" }, publicDir: dir });
  const server = http.createServer(app);
  server.keepAliveTimeout = 1;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("zonder eigen kopie komt contact_modal.js uit de runtime", async (t) => {
  const basis = await tenant(t);
  const res = await fetch(`${basis}/assets/contact_modal.js`);
  assert.equal(res.status, 200);
  const tekst = await res.text();
  assert.match(tekst, /GEDEELD, hoort bij de runtime/);
  // De twee dingen waarvoor dit bestand bestaat, in één keer gecontroleerd:
  // het toestemmingsvinkje en de adviesmodus.
  assert.match(tekst, /data-contact-akkoord/);
  assert.match(tekst, /pasTekstenAan\(source\);/, "de adviesmodus wordt ook werkelijk aangeroepen");
});

test("een eigen kopie van de tenant wint, zodat de overstap stap voor stap kan", async (t) => {
  const basis = await tenant(t, { eigenAsset: "// eigen versie van deze tenant\n" });
  const tekst = await (await fetch(`${basis}/assets/contact_modal.js`)).text();
  assert.match(tekst, /eigen versie van deze tenant/);
  assert.doesNotMatch(tekst, /GEDEELD, hoort bij de runtime/);
});

test("een bestand dat nergens staat blijft een 404", async (t) => {
  const basis = await tenant(t);
  assert.equal((await fetch(`${basis}/assets/bestaat-niet.js`)).status, 404);
});

test("de gedeelde map is niet te misbruiken om buiten de mappen te lezen", async (t) => {
  const basis = await tenant(t);
  for (const pad of ["/assets/../index.js", "/assets/..%2Findex.js", "/assets/../../package.json"]) {
    const res = await fetch(`${basis}${pad}`);
    assert.notEqual(res.status, 200, `${pad} hoort niet te werken`);
  }
});
