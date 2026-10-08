// test/mollie_terugbetaling.test.js
//
// De drie grenzen op een terugbetaling.
//
// WAAROM DEZE TEST BESTAAT
// Dit is de enige plek in de keten waar wij geld de deur uit doen. Een fout
// hier is niet "een rapport ziet er raar uit" maar "er is geld weg", en dat is
// niet terug te draaien met een deploy.
//
// Keuze Dennis, 8 oktober 2026: automatisch terugbetalen bij een order die op
// `error` strandt, met drie grenzen. Die grenzen zijn de hele veiligheid van
// deze functie, dus ze staan hier allemaal los getoetst -- inclusief het
// geval waarin ze moeten weigeren.
//
// Resend en Mollie worden niet nagebootst als pakket; alleen fetch wordt
// onderschept. Zo is de HTTP-aanroep die werkelijk uitgaat na te rekenen,
// zonder de test te koppelen aan de interne opbouw van een SDK.

import test from "node:test";
import assert from "node:assert/strict";
import { refundMolliePayment } from "../lib/mollie_client.js";

const SLEUTEL = { MOLLIE_TESTMODE: "1", MOLLIE_API_KEY_TEST: "test_abc123" };

function metOmgeving(vars, fn) {
  const oud = {};
  for (const [k, v] of Object.entries(vars)) {
    oud[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(oud)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

/**
 * Onderschept fetch en geeft een nagebootste betaling terug.
 *
 * `verzoeken` houdt bij wat er werkelijk uitging, zodat de test kan nalezen
 * welk bedrag en welke beschrijving naar Mollie gingen.
 */
function metNepMollie(betaling, fn, { refundStatus = 200, refundBody = { id: "re_1", status: "pending" } } = {}) {
  const echt = global.fetch;
  const verzoeken = [];
  global.fetch = async (url, opts = {}) => {
    verzoeken.push({ url: String(url), method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
    if (String(url).endsWith("/refunds")) {
      return { ok: refundStatus < 400, status: refundStatus, json: async () => refundBody };
    }
    return { ok: true, status: 200, json: async () => betaling };
  };
  return Promise.resolve()
    .then(() => fn(verzoeken))
    .finally(() => {
      global.fetch = echt;
    });
}

const BETAALD = {
  id: "tr_test1",
  status: "paid",
  amount: { currency: "EUR", value: "30.00" },
  amountRemaining: { currency: "EUR", value: "30.00" },
};

// --- De gelukkige weg ------------------------------------------------------

test("een betaalde betaling wordt voor het juiste bedrag terugbetaald", () =>
  metOmgeving(SLEUTEL, () =>
    metNepMollie(BETAALD, async (verzoeken) => {
      const uit = await refundMolliePayment({
        paymentId: "tr_test1",
        amountEur: 30,
        description: "Rapport niet geleverd",
      });

      assert.equal(uit.id, "re_1");
      assert.equal(uit.bedrag_eur, 30);

      // Eerst de betaling opvragen, dan terugbetalen: de betaling is de
      // waarheid, niet onze administratie.
      assert.equal(verzoeken.length, 2);
      assert.match(verzoeken[0].url, /\/payments\/tr_test1$/);
      assert.equal(verzoeken[0].method, "GET");
      assert.match(verzoeken[1].url, /\/payments\/tr_test1\/refunds$/);
      assert.equal(verzoeken[1].method, "POST");
      assert.deepEqual(verzoeken[1].body.amount, { currency: "EUR", value: "30.00" });
      assert.match(verzoeken[1].body.description, /niet geleverd/i);
    })
  ));

test("de valuta van de betaling wordt overgenomen, niet geraden", () =>
  metOmgeving(SLEUTEL, () =>
    metNepMollie({ ...BETAALD, amount: { currency: "USD", value: "30.00" }, amountRemaining: { currency: "USD", value: "30.00" } }, async (verzoeken) => {
      await refundMolliePayment({ paymentId: "tr_test1", amountEur: 30 });
      assert.equal(verzoeken[1].body.amount.currency, "USD");
    })
  ));

// --- Grens 1: alleen een betaling die werkelijk betaald is ----------------

test("een betaling die niet op paid staat wordt geweigerd", () =>
  metOmgeving(SLEUTEL, async () => {
    // Onze eigen orderstatus kan "paid" zeggen op grond van een webhook die
    // later is teruggedraaid. Dan zouden we geld terugbetalen dat we nooit
    // ontvingen.
    for (const status of ["open", "failed", "canceled", "expired", "pending", "authorized"]) {
      await metNepMollie({ ...BETAALD, status }, async (verzoeken) => {
        await assert.rejects(
          () => refundMolliePayment({ paymentId: "tr_test1", amountEur: 30 }),
          new RegExp(`staat op "${status}"`),
          `verwacht een weigering bij status ${status}`
        );
        assert.equal(verzoeken.length, 1, "er mag geen restitutieverzoek uitgaan");
      });
    }
  }));

// --- Grens 2: nooit meer dan er terugbetaalbaar is ------------------------

test("meer terugbetalen dan er resteert wordt geweigerd", () =>
  metOmgeving(SLEUTEL, () =>
    metNepMollie({ ...BETAALD, amountRemaining: { currency: "EUR", value: "10.00" } }, async (verzoeken) => {
      await assert.rejects(
        () => refundMolliePayment({ paymentId: "tr_test1", amountEur: 30 }),
        /meer dan het terugbetaalbare/,
        "30 terugbetalen op een resterend bedrag van 10 hoort te weigeren"
      );
      assert.equal(verzoeken.length, 1, "geen restitutieverzoek");
    })
  ));

test("een al volledig terugbetaalde betaling wordt niet opnieuw terugbetaald", () =>
  metOmgeving(SLEUTEL, () =>
    metNepMollie({ ...BETAALD, amountRemaining: { currency: "EUR", value: "0.00" } }, async (verzoeken) => {
      await assert.rejects(
        () => refundMolliePayment({ paymentId: "tr_test1", amountEur: 30 }),
        /niets meer terugbetaalbaar/,
        "dit is de tweede verdedigingslinie onder de afscherming in index.js"
      );
      assert.equal(verzoeken.length, 1);
    })
  ));

test("een deelbedrag binnen het resterende mag wel", () =>
  metOmgeving(SLEUTEL, () =>
    metNepMollie({ ...BETAALD, amountRemaining: { currency: "EUR", value: "10.00" } }, async (verzoeken) => {
      await refundMolliePayment({ paymentId: "tr_test1", amountEur: 10 });
      assert.equal(verzoeken[1].body.amount.value, "10.00");
    })
  ));

test("zonder amountRemaining geldt het betaalde bedrag als bovengrens", () =>
  metOmgeving(SLEUTEL, () => {
    const zonder = { id: "tr_test1", status: "paid", amount: { currency: "EUR", value: "30.00" } };
    return metNepMollie(zonder, async (verzoeken) => {
      await refundMolliePayment({ paymentId: "tr_test1", amountEur: 30 });
      assert.equal(verzoeken.length, 2, "30 op een betaling van 30 hoort te mogen");
    });
  }));

// --- Ongeldige invoer ------------------------------------------------------

test("een ontbrekend of onzinnig bedrag wordt geweigerd", () =>
  metOmgeving(SLEUTEL, async () => {
    for (const bedrag of [0, -5, null, undefined, "veel", NaN]) {
      await metNepMollie(BETAALD, async (verzoeken) => {
        await assert.rejects(
          () => refundMolliePayment({ paymentId: "tr_test1", amountEur: bedrag }),
          /ongeldig bedrag/i,
          `verwacht een weigering bij bedrag ${JSON.stringify(bedrag)}`
        );
        assert.equal(verzoeken.length, 1, "geen restitutieverzoek");
      });
    }
  }));

test("zonder paymentId gaat er geen enkel verzoek uit", () =>
  metOmgeving(SLEUTEL, () =>
    metNepMollie(BETAALD, async (verzoeken) => {
      await assert.rejects(() => refundMolliePayment({ amountEur: 30 }), /paymentId ontbreekt/);
      assert.equal(verzoeken.length, 0, "ook de betaling hoeft dan niet opgevraagd te worden");
    })
  ));

// --- Een fout van Mollie zelf ---------------------------------------------

test("een fout van Mollie komt leesbaar terug", () =>
  metOmgeving(SLEUTEL, () =>
    metNepMollie(
      BETAALD,
      async () => {
        await assert.rejects(
          () => refundMolliePayment({ paymentId: "tr_test1", amountEur: 30 }),
          /Refund niet toegestaan/
        );
      },
      { refundStatus: 422, refundBody: { detail: "Refund niet toegestaan voor deze betaling" } }
    )
  ));

// --- De sleutelkeuze geldt hier ook ---------------------------------------

test("in testmodus met een live-sleutel wordt er niets terugbetaald", () =>
  metOmgeving({ MOLLIE_TESTMODE: "1", MOLLIE_API_KEY_TEST: "live_oeps" }, () =>
    metNepMollie(BETAALD, async (verzoeken) => {
      await assert.rejects(
        () => refundMolliePayment({ paymentId: "tr_test1", amountEur: 30 }),
        /geen testsleutel/,
        "dezelfde afscherming als bij het aanmaken van een betaling"
      );
      assert.equal(verzoeken.length, 0);
    })
  ));
