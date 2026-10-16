// test/epa_in_de_tenant.test.js
//
// Een opname (een .epa of een energielabelrapport van het model 2025) als
// invoer voor het VOLLEDIGE rapport, ook op de interne route.
//
// WAAROM DEZE TEST BESTAAT
// De publieke route kon dit al: handleMidHandoff() neemt `epa_model` aan,
// bewaart hem bij de handoff en createPaymentOrder() zet hem op de
// bestelling. De interne route -- die van de adviseur, zonder betaalstap --
// deed dat niet. Een adviseur kon een .epa dus wel in het snelle rapport
// gebruiken en niet in het volledige: daar eiste de route een postcode en een
// volledig ingevuld formulier, en viel de opname onderweg weg.
//
// Dat is geen schoonheidsfout. Zonder de opname rekent de report-api met
// schattingen uit openbare bronnen in plaats van met de gemeten Rc per
// bouwdeel, en dat verandert zowel de EP2 als de geadviseerde maatregelen.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createTenantApp } from "../index.js";

const INLOG = {
  WWW_INTERNAL_EMAIL: "adviseur@example.nl",
  WWW_INTERNAL_PASSWORD: "een-wachtwoord-voor-de-test",
  WWW_INTERNAL_SESSION_SECRET: "s".repeat(48),
};

// Het kleinste model dat op een opname lijkt: een adres en een schil. Wat de
// rekenkern ermee doet staat in de report-api; hier gaat het er alleen om dat
// hij de route haalt.
const OPNAME = {
  source: "epa",
  address: { postalcode: "5654PM", housenumber: "373", houseaddition: "" },
  building: { build_year: 1969, ag_m2: 135 },
  official: { label: "C", beng2_primary_fossil_kwh_m2: 228.56 },
  schil: { roof: { area_m2: 63.9, rc: 0.35 }, facade: { area_m2: 53.5, rc: 1.47 } },
  installations: { heating_is_gas: true },
};

/** Een draaiende tenant met de adviseurslogin aan. */
async function tenant(t) {
  const oud = { ...process.env };
  Object.assign(process.env, INLOG);
  const app = createTenantApp({ id: "testtenant", brand: { name: "Test" } });
  const server = http.createServer(app);
  server.keepAliveTimeout = 1;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    for (const k of Object.keys(INLOG)) delete process.env[k];
    Object.assign(process.env, oud);
  });

  const basis = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${basis}/api/internal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: INLOG.WWW_INTERNAL_EMAIL, password: INLOG.WWW_INTERNAL_PASSWORD }),
  });
  assert.equal(login.status, 200, "de testlogin moet slagen, anders zegt de rest niets");
  const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");

  return {
    render: (body) =>
      fetch(`${basis}/api/internal/full/render`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      }),
  };
}

test("zonder opname blijft de interne route een postcode en een formulier eisen", async (t) => {
  // De controle, zodat de test hieronder niet per ongeluk slaagt doordat de
  // hele validatie weg is.
  const s = await tenant(t);
  const res = await s.render({ email: "" });
  assert.equal(res.status, 400);
  const uit = await res.json();
  assert.ok(uit.field_errors?.postalcode, "postcode hoort verplicht te blijven");
  assert.ok(uit.field_errors?.email, "en een geldig e-mailadres ook");
});

test("met een opname vervalt de eis van postcode en formulier", async (t) => {
  // DIT IS DE TEST DIE OP DE OUDE CODE FAALT: daar kwam er ook een
  // postcodefout uit, terwijl het adres gewoon in de opname staat.
  //
  // Het e-mailadres is hier met opzet leeg: dan stopt de route op dat ene
  // veld en wordt er geen bestelling aangemaakt. Zo toetst dit de validatie
  // zonder de renderketen aan te raken.
  const s = await tenant(t);
  const res = await s.render({ email: "", epa_model: OPNAME });
  assert.equal(res.status, 400);
  const uit = await res.json();
  assert.ok(uit.field_errors?.email, "het e-mailadres blijft verplicht");
  assert.equal(uit.field_errors?.postalcode, undefined, "het adres komt uit de opname");
  assert.deepEqual(Object.keys(uit.field_errors), ["email"], JSON.stringify(uit.field_errors));
});
