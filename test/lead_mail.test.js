// test/lead_mail.test.js
//
// Het samenstellen van de lead-mail: ontvangers, BCC, en de bijlage.
//
// WAAROM DEZE TEST BESTAAT
// De bijlage-keten van de lead-mail was op geen enkele lijn gedekt. Dat is
// precies de plek waar een fout stil is: de mail vertrekt, de ontvanger krijgt
// hem, en pas als iemand de bijlage opent blijkt dat het snelle rapport
// ontbreekt of leeg is.
//
// WAT HIER NIET GEBEURT
// De Resend-SDK wordt niet nagebootst. Zo'n nabootsing koppelt de test aan de
// interne opbouw van een pakket dat wij niet beheren en breekt bij elke
// update, terwijl ze niets zegt over wat er werkelijk toe doet. Daarom is het
// samenstellen afgesplitst in bouwLeadMail(): puur, zonder netwerk, en dus
// exact na te rekenen. Het verzenden zelf is één SDK-aanroep en hoort met een
// echte proefmail getoetst te worden, niet met een nabootsing.

import test from "node:test";
import assert from "node:assert/strict";
import { bouwLeadMail } from "../lib/mail_client.js";

const BASIS = {
  firstName: "Jan",
  lastName: "Jansen",
  email: "jan@voorbeeld.nl",
  phone: "0612345678",
  message: "Graag contact over mijn rapport.",
  config: {
    mail: { fromAddress: "Test <no-reply@openverduurzamen.nl>" },
    contact: { email: "info@tenant.nl" },
    product: { name: "Volledig Verduurzamingsinzicht" },
  },
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

test("de aanvrager staat op Reply-To, niet als afzender", () => {
  const m = metOmgeving({ LEAD_EMAIL: "leads@tenant.nl", MAIL_BCC_ADDRESSES: undefined }, () => bouwLeadMail(BASIS));

  assert.equal(m.replyTo, "jan@voorbeeld.nl", "antwoorden gaan naar de aanvrager");
  assert.match(m.from, /no-reply@openverduurzamen\.nl/, "verzonden vanaf het geverifieerde domein");
  assert.deepEqual(m.to, ["leads@tenant.nl"]);
});

test("LEAD_EMAIL mag een lijst zijn; zonder die variabele telt het contactadres", () => {
  const lijst = metOmgeving({ LEAD_EMAIL: "a@tenant.nl, b@tenant.nl" }, () => bouwLeadMail(BASIS));
  assert.deepEqual(lijst.to, ["a@tenant.nl", "b@tenant.nl"]);

  const terugval = metOmgeving({ LEAD_EMAIL: undefined }, () => bouwLeadMail(BASIS));
  assert.deepEqual(terugval.to, ["info@tenant.nl"], "anders komt de lead nergens aan");
});

test("zonder enig adres volgt een fout in plaats van een mail die nergens heen gaat", () => {
  assert.throws(
    () => metOmgeving({ LEAD_EMAIL: undefined }, () => bouwLeadMail({ ...BASIS, config: { mail: {} } })),
    /LEAD_EMAIL ontbreekt/
  );
});

test("MAIL_BCC_ADDRESSES komt in BCC, niet in To", () => {
  const m = metOmgeving(
    { LEAD_EMAIL: "leads@tenant.nl", MAIL_BCC_ADDRESSES: "eigenaar@openverduurzamen.nl" },
    () => bouwLeadMail(BASIS)
  );

  assert.deepEqual(m.to, ["leads@tenant.nl"]);
  assert.deepEqual(m.bcc, ["eigenaar@openverduurzamen.nl"], "de eigenaar leest mee zonder zichtbaar te zijn");
});

test("zonder BCC-variabele staat er geen leeg bcc-veld", () => {
  const m = metOmgeving({ LEAD_EMAIL: "leads@tenant.nl", MAIL_BCC_ADDRESSES: undefined }, () => bouwLeadMail(BASIS));
  assert.equal("bcc" in m, false);
});

// --- de bijlage ----------------------------------------------------------

test("een pdf gaat als base64 mee, met zijn bestandsnaam", () => {
  const pdf = Buffer.from("%PDF-1.4 nep inhoud voor de test", "utf-8");
  const m = metOmgeving({ LEAD_EMAIL: "leads@tenant.nl" }, () =>
    bouwLeadMail({ ...BASIS, attachments: [{ filename: "snel_rapport_1234AB_1.pdf", content: pdf }] })
  );

  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].filename, "snel_rapport_1234AB_1.pdf");
  assert.equal(
    Buffer.from(m.attachments[0].content, "base64").toString("utf-8"),
    "%PDF-1.4 nep inhoud voor de test",
    "de inhoud komt er heel doorheen"
  );
});

test("een html-terugval gaat net zo goed mee", () => {
  // Mislukt de pdf, dan stuurt de runtime het rapport als html mee. Die weg
  // moet net zo goed werken, anders krijgt de ontvanger een mail zonder
  // rapport terwijl alles "gelukt" lijkt.
  const m = metOmgeving({ LEAD_EMAIL: "leads@tenant.nl" }, () =>
    bouwLeadMail({
      ...BASIS,
      attachments: [{ filename: "snel_rapport.html", content: Buffer.from("<h1>Rapport</h1>", "utf-8") }],
    })
  );

  assert.equal(m.attachments[0].filename, "snel_rapport.html");
  assert.match(Buffer.from(m.attachments[0].content, "base64").toString("utf-8"), /<h1>Rapport<\/h1>/);
});

test("een bijlage zonder naam of inhoud valt weg, de rest blijft", () => {
  const m = metOmgeving({ LEAD_EMAIL: "leads@tenant.nl" }, () =>
    bouwLeadMail({
      ...BASIS,
      attachments: [
        { filename: "goed.pdf", content: Buffer.from("ok") },
        { filename: "", content: Buffer.from("geen naam") },
        { filename: "leeg.pdf", content: null },
      ],
    })
  );

  assert.deepEqual(
    m.attachments.map((a) => a.filename),
    ["goed.pdf"],
    "een halve bijlage hoort de mail niet te laten mislukken"
  );
});

test("zonder bijlagen staat er geen leeg attachments-veld", () => {
  const m = metOmgeving({ LEAD_EMAIL: "leads@tenant.nl" }, () => bouwLeadMail(BASIS));
  assert.equal("attachments" in m, false);
});

test("het bericht van de aanvrager komt in de html, zonder html-injectie", () => {
  const m = metOmgeving({ LEAD_EMAIL: "leads@tenant.nl" }, () =>
    bouwLeadMail({ ...BASIS, message: 'Hallo <script>alert("x")</script>\nTweede regel' })
  );

  assert.match(m.html, /Hallo/);
  assert.doesNotMatch(m.html, /<script>/, "tekst van buiten hoort ontdaan te zijn van opmaak");
  assert.match(m.html, /Tweede regel/);
  assert.match(m.html, /<br\/>/, "een nieuwe regel blijft een nieuwe regel");
});
