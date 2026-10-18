// lib/snelheidsgrens.js
//
// Een telling per afzender, als rem op de routes die geld kosten.
//
// WAAROM DIT ER IS (18 oktober 2026)
// Een tenant zonder `features.toegang` staat open. Dat is bedoeld voor de
// bezoeker die het formulier invult -- maar de routes eronder zijn gewoon
// aan te roepen zonder dat formulier, en ze kosten per keer geld:
//
//   /api/mid/lookup            vijf betaalde Altum-aanroepen, ongeveer EUR 1
//   /api/full/lookup-address   hetzelfde
//   /api/mid/stream            het taalmodel voor het snelle rapport
//   /api/mid/listing-extract   het taalmodel leest een advertentie
//   /api/epa/ingest            de report-api leest een opname uit
//   /api/label-pdf/ingest      idem voor een energielabel als pdf
//
// De sleutel naar de report-api zit in de tenant, dus wie deze routes
// aanroept betaalt niet zelf. Bij softbee en openverduurzamen staat die deur
// open voor iedereen die het adres van de dienst kent.
//
// WAT DIT WEL EN NIET IS
// Een rem, geen slot -- zelfde afweging als in de report-api. Het geheugen is
// van een proces: bij meerdere instanties telt elk voor zich, en na een
// herstart begint de telling opnieuw. Tegen een aanval met honderd adressen
// helpt het niet. Het helpt tegen wat hier het meest waarschijnlijk is:
// iemand die een losse route in een lus zet.
//
// Een echt slot zou een sleutel op deze routes zijn, en dan werkt het
// publieke formulier niet meer. Dat is de afweging; wie de tenant wil
// dichtzetten gebruikt `features.toegang`.

/** Hoeveel sleutels we onthouden voordat we opruimen. */
const MAX_BIJGEHOUDEN = 10000;

export function maakSnelheidsgrens({ perVenster = 20, vensterMs = 60 * 60 * 1000, nu = () => Date.now() } = {}) {
  /** @type {Map<string, {tot: number, aantal: number}>} */
  const tellers = new Map();

  /**
   * Gooi alles weg waarvan het venster voorbij is.
   *
   * Nodig omdat de sleutel een IP-adres is: zonder opruimen groeit de map met
   * elk nieuw adres mee, en dan is de begrenzer zelf het lek.
   */
  function ruimOp(t) {
    for (const [sleutel, teller] of tellers) {
      if (teller.tot <= t) tellers.delete(sleutel);
    }
  }

  return {
    /**
     * @returns {{toegestaan: boolean, resterend: number, wachtS: number}}
     */
    tel(sleutel) {
      const t = nu();
      if (tellers.size > MAX_BIJGEHOUDEN) ruimOp(t);

      const bestaand = tellers.get(sleutel);
      if (!bestaand || bestaand.tot <= t) {
        tellers.set(sleutel, { tot: t + vensterMs, aantal: 1 });
        return { toegestaan: true, resterend: perVenster - 1, wachtS: 0 };
      }

      bestaand.aantal += 1;
      if (bestaand.aantal > perVenster) {
        return { toegestaan: false, resterend: 0, wachtS: Math.ceil((bestaand.tot - t) / 1000) };
      }
      return { toegestaan: true, resterend: perVenster - bestaand.aantal, wachtS: 0 };
    },

    /** Alleen voor tests en voor het opstartlog. */
    omvang() {
      return tellers.size;
    },
  };
}

export default { maakSnelheidsgrens };
