// test/mislukte_order_mail.test.js
//
// De mail aan een klant wiens bestelling niet geleverd kon worden.
//
// WAAROM DEZE TEST BESTAAT
// In deze mail staat een mededeling over geld, en dat is het soort zin dat
// klopt of niet klopt. Drie standen, en ze mogen niet verwisseld worden:
//
//   terugbetaald      "het bedrag is aan u terugbetaald"  -- een mededeling
//   poging mislukt    "u krijgt het terug, wij regelen het met de hand"
//   niet betaald      "u krijgt het terug, neem contact op"
//
// Een belofte die niet waargemaakt is, is erger dan geen belofte. Daarom staat
// de eerste variant er alleen als de terugbetaling werkelijk is gelukt.
//
// Het samenstellen is afgesplitst van het verzenden (zoals bij bouwLeadMail),
// zodat dit zonder netwerk en zonder nabootsing van de Resend-SDK na te rekenen
// is. Het verzenden zelf is één SDK-aanroep en hoort met een echte proefmail
// getoetst te worden.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { bouwMislukteOrderMail } from "../lib/mail_client.js";

const CONFIG = {
  id: "softbee",
  brand: { name: "Softbee" },
  product: { name: "Softbee Verduurzamingsrapport" },
  contact: { phone: "085 - 060 12 34", email: "hallo@softbee.nl" },
  mail: { fromAddress: "Softbee <no-reply@openverduurzamen.nl>" },
};

const ORDER = {
  id: "cf97432ba6970d5b3cd18811",
  email: "klant@voorbeeld.nl",
  amount_eur: 30,
  address: { postalcode: "2625ZD", housenumber: "9" },
};

function metOmgeving(vars, fn) {
  const oud = {};
  for (const [k, v] of Object.entries(vars)) {
    oud[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(oud)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// --- De drie standen over het geld ----------------------------------------

test("gelukte terugbetaling: de mail zegt dat het bedrag terug is", () => {
  const m = bouwMislukteOrderMail({
    order: ORDER,
    config: CONFIG,
    terugbetaling: { gepoogd: true, gelukt: true, id: "re_1", bedrag_eur: 30 },
  });

  assert.match(m.html, /is aan u terugbetaald/);
  assert.match(m.html, /30,00/, "het bedrag staat erin, met een komma");
  assert.doesNotMatch(m.html, /met de hand/, "geen handwerk beloven als het al gelukt is");
  assert.doesNotMatch(m.html, /neem contact met ons op, dan zorgen wij/i);
});

test("mislukte poging: geen mededeling, maar een vraag om contact", () => {
  const m = bouwMislukteOrderMail({
    order: ORDER,
    config: CONFIG,
    terugbetaling: { gepoogd: true, gelukt: false, error: "Mollie weigerde" },
  });

  assert.match(m.html, /U krijgt .* terug/);
  assert.match(m.html, /niet gelukt/, "de klant hoort te weten dat het handwerk wordt");
  assert.doesNotMatch(m.html, /is aan u terugbetaald/, "niets beloven wat niet gebeurd is");
  // De interne foutmelding hoort niet in een klantmail.
  assert.doesNotMatch(m.html, /Mollie weigerde/);
});

test("niet betaald: wel bericht, en de weg naar het geld", () => {
  const m = bouwMislukteOrderMail({ order: ORDER, config: CONFIG, terugbetaling: { gepoogd: false, gelukt: false } });

  assert.match(m.html, /U krijgt .* terug/);
  assert.match(m.html, /Neem contact met ons op/i);
  assert.doesNotMatch(m.html, /is aan u terugbetaald/);
});

test("zonder enige opgave over de terugbetaling blijft de mail veilig", () => {
  // Zou terugbetaling null zijn, dan mag er geen belofte uitrollen.
  const m = bouwMislukteOrderMail({ order: ORDER, config: CONFIG });
  assert.doesNotMatch(m.html, /is aan u terugbetaald/);
  assert.match(m.html, /U krijgt .* terug/);
});

// --- Wat er altijd in moet staan ------------------------------------------

test("het ordernummer staat erin, want daarmee vindt support de bestelling", () => {
  const m = bouwMislukteOrderMail({ order: ORDER, config: CONFIG, terugbetaling: { gelukt: true } });
  assert.match(m.html, /cf97432ba6970d5b3cd18811/);
  assert.match(m.subject, /cf97432ba6970d5b3cd18811/);
});

test("de contactgegevens van de tenant staan erin", () => {
  const m = bouwMislukteOrderMail({ order: ORDER, config: CONFIG, terugbetaling: { gelukt: true } });
  assert.match(m.html, /085 - 060 12 34/);
  assert.match(m.html, /hallo@softbee\.nl/);
  assert.match(m.html, /Softbee/);
});

test("zonder contactgegevens verwijst de mail naar de website in plaats van naar niets", () => {
  const m = bouwMislukteOrderMail({
    order: ORDER,
    config: { ...CONFIG, contact: {} },
    terugbetaling: { gelukt: true },
  });
  assert.match(m.html, /contactgegevens op onze website/);
});

test("het adres van de woning staat erin als we het hebben", () => {
  const m = bouwMislukteOrderMail({ order: ORDER, config: CONFIG, terugbetaling: { gelukt: true } });
  assert.match(m.html, /2625ZD 9/);

  const zonder = bouwMislukteOrderMail({
    order: { ...ORDER, address: {} },
    config: CONFIG,
    terugbetaling: { gelukt: true },
  });
  // Let op de regex: /voor\s*\./ matcht ook "daarvoor." aan het eind van de
  // zin, en viel dus op een correcte mail. Het gaat om een losgeslagen "voor"
  // vlak voor de punt.
  assert.doesNotMatch(zonder.html, /leveren voor/, "geen halve zin zonder adres");
  assert.match(zonder.html, /op te leveren\. Onze excuses/, "de zin loopt gewoon door");
});

// --- Afzender, ontvanger, BCC ---------------------------------------------

test("de mail gaat naar de klant, vanaf het geverifieerde domein", () => {
  const m = bouwMislukteOrderMail({ order: ORDER, config: CONFIG, terugbetaling: { gelukt: true } });
  assert.deepEqual(m.to, ["klant@voorbeeld.nl"]);
  assert.match(m.from, /no-reply@openverduurzamen\.nl/);
});

test("MAIL_BCC_ADDRESSES komt in BCC, en zonder die variabele staat er geen leeg veld", () => {
  const met = metOmgeving({ MAIL_BCC_ADDRESSES: "eigenaar@openverduurzamen.nl" }, () =>
    bouwMislukteOrderMail({ order: ORDER, config: CONFIG, terugbetaling: { gelukt: true } })
  );
  assert.deepEqual(met.bcc, ["eigenaar@openverduurzamen.nl"]);

  const zonder = metOmgeving({ MAIL_BCC_ADDRESSES: undefined }, () =>
    bouwMislukteOrderMail({ order: ORDER, config: CONFIG, terugbetaling: { gelukt: true } })
  );
  assert.equal("bcc" in zonder, false);
});

test("zonder e-mailadres volgt een fout in plaats van een mail die nergens heen gaat", () => {
  assert.throws(
    () => bouwMislukteOrderMail({ order: { ...ORDER, email: "" }, config: CONFIG }),
    /order\.email ontbreekt/
  );
});

test("een ontbrekend bedrag levert geen 'NaN' in de mail op", () => {
  const m = bouwMislukteOrderMail({
    order: { ...ORDER, amount_eur: undefined },
    config: CONFIG,
    terugbetaling: { gelukt: true },
  });
  assert.doesNotMatch(m.html, /NaN/);
  assert.match(m.html, /het betaalde bedrag/);
});
