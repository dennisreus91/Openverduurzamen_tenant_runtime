// test/lead_route.test.js
//
// WAAROM DEZE TEST BESTAAT
// De leadroute was alleen gedekt op "bestaat ze?" (verenigde_runtime.test.js post er een leeg
// object naartoe en kijkt of het geen 404 is). Daardoor stopte de dekking bij de validatie: alles
// wat daarna gebeurt -- de rapportcontext, het adres voor de partnermail, de aanroep naar
// bouwLeadMail -- liep op geen enkele test.
//
// Dat is precies de plek waar een ontbrekende declaratie stil blijft: `node --check` ziet een
// variabele die niet bestaat niet, en de route valt pas om bij het eerste echte verzoek.
//
// Deze test loopt de route helemaal af met een geldige aanvraag. Zonder RESEND_API_KEY strandt
// hij bij het verzenden -- dat is het punt: de melding moet over de mailprovider gaan en niet
// over een variabele. De Resend-SDK wordt bewust niet nagebootst (zie lead_mail.test.js).

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createTenantApp } from "../index.js";

async function listen(handler) {
  const server = http.createServer(handler);
  server.keepAliveTimeout = 1;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

const AANVRAAG = {
  firstName: "Jan",
  lastName: "Jansen",
  email: "jan@voorbeeld.nl",
  phone: "0612345678",
  message: "Graag contact.",
  sourcePage: "/verduurzamingsadvies",
};

/** Doet een leadverzoek en geeft { status, body, logregels } terug. */
async function leadVerzoek(body) {
  const oudeSleutel = process.env.RESEND_API_KEY;
  const oudLeadEmail = process.env.LEAD_EMAIL;
  delete process.env.RESEND_API_KEY;
  process.env.LEAD_EMAIL = "crm@woonwijzerwinkel.nl";

  const logregels = [];
  const echteError = console.error;
  console.error = (...args) => logregels.push(args.map(String).join(" "));

  const app = createTenantApp({ id: "testtenant", brand: { name: "Test" }, contact: { email: "info@tenant.nl" } });
  const server = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/lead`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json(), logregels };
  } finally {
    console.error = echteError;
    await server.close();
    if (oudeSleutel === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = oudeSleutel;
    if (oudLeadEmail === undefined) delete process.env.LEAD_EMAIL;
    else process.env.LEAD_EMAIL = oudLeadEmail;
  }
}

test("de route komt tot het verzenden toe, en strandt daar op de ontbrekende sleutel", async () => {
  const { status, logregels } = await leadVerzoek(AANVRAAG);
  assert.equal(status, 500);
  const log = logregels.join("\n");
  assert.match(log, /RESEND_API_KEY/, `verwacht een melding over de mailprovider, kreeg:\n${log}`);
  // Een niet-bestaande variabele of functie geeft een ReferenceError of TypeError op precies dit
  // pad. Die moet hier niet staan, anders is de route onderweg omgevallen.
  assert.doesNotMatch(log, /ReferenceError|is not defined|TypeError/, log);
});

test("ook met een adres in de context komt de route tot het verzenden toe", async () => {
  // Dit is de tak die het adres voor de partnermail vastlegt. Zonder deze aanvraag loopt die
  // regel op geen enkele test.
  const { status, logregels } = await leadVerzoek({
    ...AANVRAAG,
    context: { productType: "mid_report", address: { postalcode: "3848DX", housenumber: "9" } },
  });
  assert.equal(status, 500);
  const log = logregels.join("\n");
  assert.match(log, /RESEND_API_KEY/, log);
  assert.doesNotMatch(log, /ReferenceError|is not defined|TypeError/, log);
});

test("de validatie houdt een onvolledige aanvraag tegen", async () => {
  const { status, body } = await leadVerzoek({ firstName: "Jan" });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.match(body.error, /Achternaam/);
});

test("de honeypot doet alsof het gelukt is en verstuurt niets", async () => {
  const { status, body, logregels } = await leadVerzoek({ ...AANVRAAG, website: "http://spam.example" });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.doesNotMatch(logregels.join("\n"), /RESEND_API_KEY/, "er is niets verstuurd");
});
