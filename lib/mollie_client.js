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
