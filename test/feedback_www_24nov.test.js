// test/feedback_www_24nov.test.js
//
// Feedback van de WoonWijzerWinkel, 24 november 2026, het deel in de runtime:
//   - met de rapportvragen aan is de naam optioneel en het telefoonnummer alleen nodig bij ja
//     op het expertgesprek;
//   - op de zuil gaat het snelle rapport per e-mail naar de bezoeker (bouwSnelRapportMail).

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { createTenantApp } from "../index.js";
import { bouwSnelRapportMail } from "../lib/mail_client.js";

async function lead(body) {
  const oud = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const echteError = console.error;
  console.error = () => {};
  const app = createTenantApp({
    id: "testtenant", brand: { name: "Test" }, contact: { email: "info@tenant.nl" },
    features: { rapportVragen: true },
  });
  const server = http.createServer(app);
  server.keepAliveTimeout = 1;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/lead`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    console.error = echteError;
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    if (oud !== undefined) process.env.RESEND_API_KEY = oud;
  }
}

const BASIS = { email: "jan@voorbeeld.nl", sourcePage: "snel_rapport_download" };

test("alleen het rapport: geen naam en geen telefoonnummer nodig", async () => {
  const { status, body } = await lead({ ...BASIS, wensen: { expertGesprek: "nee", offertes: "nee", scenario: "Geen voorkeur" } });
  // 500 = de route kwam tot het verzenden (geen RESEND_API_KEY in de test); 400 zou een validatiefout zijn.
  assert.notEqual(status, 400, JSON.stringify(body));
});

test("ja op het expertgesprek: dan is het telefoonnummer verplicht", async () => {
  const { status, body } = await lead({ ...BASIS, wensen: { expertGesprek: "ja", offertes: "nee", scenario: "Geen voorkeur" } });
  assert.equal(status, 400);
  assert.match(body.error, /telefoonnummer/i);
  assert.doesNotMatch(body.error, /Voornaam|Achternaam/);
});

test("zonder rapportvragen blijven naam en telefoon verplicht", async () => {
  const { status, body } = await lead({ email: "jan@voorbeeld.nl", sourcePage: "/contact" });
  assert.equal(status, 400);
  assert.match(body.error, /Voornaam/);
  assert.match(body.error, /telefoonnummer/i);
});

test("de mail van de zuil gaat naar de bezoeker, met de pdf erbij", () => {
  const m = bouwSnelRapportMail({
    to: "jan@voorbeeld.nl", pdfBuffer: Buffer.from("%PDF"), filename: "snel_verduurzamingsinzicht_x.pdf",
    config: { brand: { name: "WoonWijzerWinkel" }, mail: { fromAddress: "WoonWijzerWinkel <no-reply@openverduurzamen.nl>" } },
    addressLine: "Dorpsstraat 1, 1234AB Ergens",
  });
  assert.equal(m.to, "jan@voorbeeld.nl");
  assert.match(m.subject, /snelle verduurzamingsinzicht – Dorpsstraat 1/);
  assert.equal(m.attachments[0].filename, "snel_verduurzamingsinzicht_x.pdf");
  assert.match(m.html, /startpunt/);
  assert.match(m.html, /expert van WoonWijzerWinkel/);
});

test("de zuil verbergt de downloadknop niet meer, maar maakt er een mailknop van", () => {
  const js = fs.readFileSync(new URL("../assets/kiosk.js", import.meta.url), "utf8");
  assert.doesNotMatch(js, /\[data-action=rapport-downloaden\]\{display:none/);
  assert.match(js, /Stuur dit rapport naar mijn e-mail/);
  assert.match(js, /openContactModal\("snel_rapport_download"\)/);
});
