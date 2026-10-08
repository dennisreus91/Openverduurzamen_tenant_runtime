const MOLLIE_BASE = "https://api.mollie.com/v2";

/**
 * De sleutel waarmee betalingen worden aangemaakt.
 *
 * Standaard MOLLIE_API_KEY. Zet MOLLIE_TESTMODE=1, dan wordt
 * MOLLIE_API_KEY_TEST gebruikt: de bestelstraat is dan van begin tot eind te
 * doorlopen zonder dat er geld in beweging komt.
 *
 * Twee bewuste keuzes:
 *
 * 1. De testsleutel wordt NOOIT vanzelf gekozen omdat hij toevallig gezet is.
 *    Een tenant die per ongeluk in testmodus staat, levert rapporten uit
 *    zonder dat er betaald is. De schakelaar is daarom een eigen variabele,
 *    en hij kan alleen uit de omgeving komen -- nooit uit een request.
 * 2. In testmodus moet de sleutel ook echt een testsleutel zijn. Mollie
 *    prefixt die met `test_`; staat er een `live_`-sleutel, dan stopt de
 *    runtime met een duidelijke melding in plaats van echte betalingen aan te
 *    maken terwijl iedereen denkt te testen.
 */
function getApiKey() {
  if (String(process.env.MOLLIE_TESTMODE || "").trim() === "1") {
    const test = String(process.env.MOLLIE_API_KEY_TEST || "").trim();
    if (!test) throw new Error("MOLLIE_TESTMODE=1 maar MOLLIE_API_KEY_TEST ontbreekt.");
    if (!test.startsWith("test_")) {
      throw new Error("MOLLIE_TESTMODE=1 maar MOLLIE_API_KEY_TEST is geen testsleutel (verwacht een `test_`-prefix).");
    }
    return test;
  }
  const key = process.env.MOLLIE_API_KEY;
  if (!key) throw new Error("MOLLIE_API_KEY ontbreekt.");
  return key;
}

/** Of deze runtime betalingen in testmodus aanmaakt. Voor de opstartmelding. */
export function mollieTestmodus() {
  return String(process.env.MOLLIE_TESTMODE || "").trim() === "1";
}

function getHeaders() {
  return {
    Authorization: `Bearer ${getApiKey()}`,
    "Content-Type": "application/json",
  };
}

export function toMoneyValue(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Ongeldig bedrag voor Mollie.");
  return n.toFixed(2);
}

export async function createMolliePayment({ amountEur, description, redirectUrl, webhookUrl, metadata }) {
  const res = await fetch(`${MOLLIE_BASE}/payments`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      amount: { currency: process.env.CURRENCY || "EUR", value: toMoneyValue(amountEur) },
      description,
      redirectUrl,
      webhookUrl,
      metadata,
    }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.detail || json?.title || `Mollie create payment failed (${res.status})`);

  return {
    id: json.id,
    status: json.status,
    checkout_url: json._links?.checkout?.href || null,
    raw: json,
  };
}

export async function getMolliePayment(paymentId) {
  const res = await fetch(`${MOLLIE_BASE}/payments/${encodeURIComponent(paymentId)}`, { headers: getHeaders() });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.detail || json?.title || `Mollie get payment failed (${res.status})`);
  return json;
}

/**
 * Betaalt een geslaagde betaling terug.
 *
 * WAAROM DIT BESTAAT
 * Een klant die betaald heeft en geen rapport krijgt, moet zijn geld terug.
 * Tot 8 oktober 2026 was daar niets voor: een order die op `error` strandde
 * bleef staan, de klant kreeg geen bericht, en het bedrag bleef bij ons. De
 * afrondpagina zegt zelf dat de klant hem mag sluiten, dus wie dat deed hoorde
 * nooit meer iets.
 *
 * DRIE GRENZEN, EN WAAROM ELK ERVAN
 * 1. Alleen wanneer de betaling bij Mollie werkelijk op `paid` staat. Onze
 *    eigen orderstatus is daarvoor niet goed genoeg: die kan "paid" zeggen op
 *    grond van een webhook die later is teruggedraaid, en dan zouden we geld
 *    terugbetalen dat we nooit ontvingen.
 * 2. Nooit meer dan het betaalde bedrag, en nooit meer dan wat er nog
 *    terugbetaalbaar is (`amountRemaining`). Mollie weigert dat zelf ook, maar
 *    een eigen controle geeft een begrijpelijke melding in plaats van een
 *    API-fout.
 * 3. Eén keer per order. Die afscherming zit in index.js, want alleen daar is
 *    de orderstaat bekend; deze functie weigert wel een tweede restitutie
 *    zodra er niets meer terugbetaalbaar is.
 *
 * @returns {{id: string, status: string, bedrag_eur: number, raw: object}}
 */
export async function refundMolliePayment({ paymentId, amountEur, description }) {
  if (!paymentId) throw new Error("refundMolliePayment: paymentId ontbreekt.");

  // Grens 1 en 2: de betaling zelf is de waarheid, niet onze administratie.
  const betaling = await getMolliePayment(paymentId);
  if (String(betaling?.status) !== "paid") {
    throw new Error(
      `Terugbetaling geweigerd: betaling ${paymentId} staat op "${betaling?.status}" en niet op "paid".`
    );
  }

  const gevraagd = Number(amountEur);
  const betaald = Number(betaling?.amount?.value);
  // amountRemaining ontbreekt zodra er niets meer terugbetaalbaar is; dan
  // valt de controle terug op het betaalde bedrag.
  const resterend =
    betaling?.amountRemaining?.value != null ? Number(betaling.amountRemaining.value) : betaald;

  if (!Number.isFinite(gevraagd) || gevraagd <= 0) {
    throw new Error(`Terugbetaling geweigerd: ongeldig bedrag (${amountEur}).`);
  }
  if (!(resterend > 0)) {
    throw new Error(`Terugbetaling geweigerd: betaling ${paymentId} heeft niets meer terugbetaalbaar.`);
  }
  if (gevraagd > resterend + 0.001) {
    throw new Error(
      `Terugbetaling geweigerd: gevraagd ${toMoneyValue(gevraagd)} is meer dan het terugbetaalbare ${toMoneyValue(resterend)}.`
    );
  }

  const res = await fetch(`${MOLLIE_BASE}/payments/${encodeURIComponent(paymentId)}/refunds`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      amount: {
        currency: betaling?.amount?.currency || process.env.CURRENCY || "EUR",
        value: toMoneyValue(gevraagd),
      },
      description: String(description || "Terugbetaling: rapport niet geleverd").slice(0, 140),
    }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.detail || json?.title || `Mollie refund failed (${res.status})`);

  return { id: json.id, status: json.status, bedrag_eur: gevraagd, raw: json };
}
