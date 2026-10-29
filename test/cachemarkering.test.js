// test/cachemarkering.test.js
//
// De ?v= achter /assets/… komt uit de INHOUD van het bestand, niet uit het sjabloon.
//
// WAAROM DEZE TEST BESTAAT
// De markering stond met de hand in mid_start.html. Op 29 oktober 2026 ging dat twee keer
// op één dag mis: het bestand was nieuw, de markering niet, en een bezoeker die er eerder
// was geweest hield de oude versie uit zijn cache. Die dag betekende dat de gegevenspoort
// voor terugkerende bezoekers niet bestond, op een tenant die net publiek was gegaan.
//
// Van buiten was er niets aan te zien: de server gaf het nieuwe bestand, de browser nam
// het oude, en beide hadden gelijk. Zo'n fout vind je niet terug met een test op de
// server en ook niet met een test op het bestand -- alleen door de twee tegen elkaar te
// leggen, en dat is wat hier gebeurt.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createTenantApp } from "../index.js";

/** Een tenant met een eigen public/-map, zodat de test zijn eigen assets kan schrijven. */
async function tenant(t, { bestand = "mid_app.js", inhoud = "console.log(1);", markering = "20200101a" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cachemarkering-"));
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "templates"), { recursive: true });
  fs.writeFileSync(path.join(dir, "assets", bestand), inhoud);
  fs.writeFileSync(
    path.join(dir, "templates", "mid_start.html"),
    `<!doctype html><html><body>
     <link rel="stylesheet" href="/assets/mid_styles.css?v=${markering}">
     <script src="/assets/${bestand}?v=${markering}"></script>
     <script src="/assets/contact_modal.js?v=${markering}"></script>
     </body></html>`
  );

  const server = http.createServer(createTenantApp({ id: "testtenant", brand: { name: "Test" }, publicDir: dir }));
  server.keepAliveTimeout = 1;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });
  const basis = `http://127.0.0.1:${server.address().port}`;
  return {
    dir,
    pagina: async () => (await fetch(basis, { headers: { accept: "text/html" } })).text(),
    markeringVan: (naam, html) => (html.match(new RegExp("/assets/" + naam.replace(".", "\\.") + "\\?v=([A-Za-z0-9._-]+)")) || [])[1],
  };
}

const hash = (tekst) => crypto.createHash("sha256").update(tekst).digest("hex").slice(0, 10);

test("de markering is de hash van het bestand, niet wat er in het sjabloon stond", async (t) => {
  const inhoud = "console.log('poortcode');";
  const s = await tenant(t, { inhoud });
  const html = await s.pagina();
  assert.equal(s.markeringVan("mid_app.js", html), hash(inhoud));
  assert.notEqual(s.markeringVan("mid_app.js", html), "20200101a",
    "de handmatige markering hoort vervangen te zijn");
});

test("twee bestanden met verschillende inhoud krijgen verschillende markeringen", async (t) => {
  // Anders zou één gedeelde markering genoeg zijn, en dan loopt hij weer achter zodra er
  // maar één van de twee verandert.
  const s = await tenant(t, { inhoud: "a" });
  const html = await s.pagina();
  const app = s.markeringVan("mid_app.js", html);
  const modal = s.markeringVan("contact_modal.js", html);
  assert.ok(app && modal);
  assert.notEqual(app, modal);
});

test("een gedeeld bestand van de runtime krijgt ook een markering", async (t) => {
  // contact_modal.js staat niet bij de tenant maar bij de runtime. Juist dat bestand liep
  // achter: een tenant zonder eigen kopie heeft geen reden om aan zijn sjabloon te denken.
  const s = await tenant(t);
  const markering = s.markeringVan("contact_modal.js", await s.pagina());
  assert.match(markering, /^[0-9a-f]{10}$/);
});

test("een bestand dat niet bestaat houdt de markering uit het sjabloon", async (t) => {
  // Liever de oude waarde dan een kapotte verwijzing: een ontbrekend bestand is al een
  // probleem, en de pagina hoort daar niet bovenop om te vallen.
  const s = await tenant(t);
  const html = await s.pagina();
  assert.equal(s.markeringVan("mid_styles.css", html), "20200101a");
});

test("een gewijzigd bestand geeft een andere markering", async (t) => {
  // De kern: dit is wat een handmatige markering niet kan.
  const eerst = await tenant(t, { inhoud: "versie 1" });
  const daarna = await tenant(t, { inhoud: "versie 2" });
  assert.notEqual(
    eerst.markeringVan("mid_app.js", await eerst.pagina()),
    daarna.markeringVan("mid_app.js", await daarna.pagina())
  );
});
