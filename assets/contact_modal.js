/* contact_modal.js -- GEDEELD, hoort bij de runtime
 *
 * Het contactvenster op mid_start, full_start en full_done. Start zichzelf als er
 * een [data-contact-modal] op de pagina staat; opent bij [data-action="open-contact"].
 * Post naar /api/lead van de tenant-runtime.
 *
 * WAAROM DIT BESTAND HIER STAAT EN NIET BIJ ELKE TENANT
 * Tot 14 oktober 2026 had elke tenant zijn eigen kopie. Die waren uit elkaar gelopen,
 * en niet toevallig: Softbee had een focus-trap en focusherstel die de andere drie
 * misten, De Energie Raadgever had de adviesmodus, en het terugvaladres in de
 * foutmelding stond overal anders hardgecodeerd. Een verbetering op een plek bereikte
 * de rest nooit.
 *
 * Deze versie is Softbee's variant -- de verste -- met de adviesmodus erbij en met de
 * partnernaam en het terugvaladres uit /api/tenant in plaats van in de code. De
 * runtime serveert dit bestand op /assets/contact_modal.js zodra een tenant geen
 * eigen kopie meer heeft; heeft hij er wel een, dan wint die nog steeds.
 */
(function () {
  const ENDPOINT = "/api/lead";
  const MAX_MESSAGE = 2000;

  function $(root, sel) { return root.querySelector(sel); }
  function $$(root, sel) { return Array.from(root.querySelectorAll(sel)); }

  // De tenantgegevens, een keer opgehaald en door alle onderdelen gedeeld: de
  // toestemmingstekst, de naam van de adviespartner en het terugvaladres in de
  // foutmelding. Mislukt het, dan blijft alles werken op de standaardwaarden.
  let tenantData = null;
  async function haalTenant() {
    if (tenantData) return tenantData;
    try {
      const res = await fetch("/api/tenant", { headers: { Accept: "application/json" } });
      tenantData = await res.json();
    } catch (_) {
      tenantData = {};
    }
    return tenantData;
  }

  function init() {
    const modal = document.querySelector("[data-contact-modal]");
    if (!modal) return;

    const form = $(modal, "[data-contact-form]");
    const closeButtons = $$(modal, "[data-action='close-contact']");
    const successBox = $(modal, "[data-contact-success]");
    const errorBox = $(modal, "[data-contact-error]");
    const submitBtn = $(modal, "[data-contact-submit]");
    const message = $(modal, "[name='message']");
    const counter = $(modal, "[data-contact-counter]");
    const firstField = $(modal, "[name='firstName']");

    let lastFocused = null;

    function open(source) {
      // Teksten eerst: bij source "advies_partner" wordt dit het adviesvenster van
      // de partner, anders staan de oorspronkelijke teksten er weer. Zonder deze
      // regel is pasTekstenAan() gedefinieerd maar roept niemand hem aan -- en dat
      // ziet een syntaxcontrole niet.
      pasTekstenAan(source);
      // Refresh context just-in-time. Pages can install a provider that
      // returns the current lead context (form values, order id, etc.).
      try {
        if (typeof window.__leadContextProvider === "function") {
          const ctx = window.__leadContextProvider();
          if (ctx && typeof ctx === "object") window.__leadContext = ctx;
        }
      } catch (e) {}
      // Remember the opener so close() can hand focus back (a11y).
      lastFocused = document.activeElement;
      // Restore form visibility — a prior successful submit hides these.
      $$(modal, ".contactModal__sectionLabel, .contactModal__grid, .contactModal__field, .contactModal__actions, .contactModal__lead").forEach(function (el) {
        el.style.display = "";
      });
      successBox?.setAttribute("hidden", "");
      errorBox?.setAttribute("hidden", "");
      modal.classList.add("is-open");
      modal.removeAttribute("hidden");
      document.body?.classList.add("modal-open");
      // Tag where the user came from (CTA context) so WWW can see it in the email.
      const srcInput = $(modal, "[name='sourcePage']");
      if (srcInput) srcInput.value = source || "";
      setTimeout(function () { firstField?.focus(); }, 30);
      notifyHeightChange();
    }
    function close() {
      modal.classList.remove("is-open");
      modal.setAttribute("hidden", "");
      document.body?.classList.remove("modal-open");
      // Reset state but keep field values in case user wants to reopen.
      successBox?.setAttribute("hidden", "");
      errorBox?.setAttribute("hidden", "");
      if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
      notifyHeightChange();
    }

    // Focus trap: keep Tab cycling inside the dialog while it is open.
    const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Tab" || !modal.classList.contains("is-open")) return;
      const items = $$(modal, FOCUSABLE).filter(function (el) { return el.offsetParent !== null; });
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !modal.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    });

    function notifyHeightChange() {
      // The mid_start page lives in an iframe that auto-resizes via
      // postMessage. Force a re-measure so the parent doesn't clip the modal.
      try {
        if (window.parent && window.parent !== window) {
          const h = Math.max(
            document.body?.scrollHeight || 0,
            (document.querySelector(".appShell, .pageWrap") || document.body)?.getBoundingClientRect().bottom || 0
          );
          // We send the same message shape mid_app.js uses, so the parent
          // listener picks it up either way.
          const parentOrigin = new URLSearchParams(location.search).get("parentOrigin") || "*";
          window.parent.postMessage({ type: "mid_report_height", height: Math.ceil(h) }, parentOrigin);
        }
      } catch (e) {}
    }

    // Wire open clicks (delegated, since CTA buttons can be injected later).
    document.addEventListener("click", function (e) {
      const opener = e.target?.closest?.("[data-action='open-contact']");
      if (!opener) return;
      e.preventDefault();
      open(opener.dataset.contactSource || "");
    });

    // Het venster ook zonder knop kunnen openen. De pagina van
    // OpenVerduurzamen doet dat: daar is de knop "Volledig rapport
    // aanvragen" van de report-api, die geen data-action voor dit venster
    // draagt, en loopt de aanvraag eerst door eigen controles heen.
    //
    // Een functie op window en geen nagebootste klik: een klik ergens
    // afvuren om een venster te openen is niet te lezen, en een lege
    // bronnaam zou stil de verkeerde teksten geven.
    window.openContactModal = function (source) { open(source || ""); };

    closeButtons.forEach(function (b) { b.addEventListener("click", close); });

    // Close on backdrop click (only when the overlay itself is the target,
    // so clicks inside the form don't close).
    $(modal, "[data-contact-backdrop]")?.addEventListener("click", close);

    // ESC closes.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && modal.classList.contains("is-open")) close();
    });

    // Character counter for message field.
    if (message && counter) {
      message.setAttribute("maxlength", String(MAX_MESSAGE));
      const update = function () {
        const len = (message.value || "").length;
        counter.textContent = len + "/" + MAX_MESSAGE;
      };
      message.addEventListener("input", update);
      update();
    }

    if (!form) return;
    // Aanvraag vrijblijvend advies bij de partner van deze tenant. Hetzelfde venster,
    // andere teksten; de aanvraag gaat met het snelle rapport naar het vaste adres van
    // die partner. Een tenant zonder adviespartner komt hier nooit langs: zijn paginas
    // openen het venster niet met source "advies_partner", dus adviesModus blijft false
    // en de oorspronkelijke teksten blijven staan.
    const titleEl = $(modal, "#contactModalTitle");
    const leadEl = $(modal, ".contactModal__lead");
    const origineel = {
      title: titleEl ? titleEl.textContent : "",
      lead: leadEl ? leadEl.innerHTML : "",
      success: successBox ? successBox.textContent : "",
      submit: submitBtn ? submitBtn.textContent : "",
    };
    let adviesModus = false;
    let rapportModus = false;
    let huidigeBron = "";
    // Het volledige rapport aanvragen vanuit het snelle rapport, in hetzelfde
    // venster. Een stap voor de bezoeker, twee dingen tegelijk: hij vraagt het
    // rapport aan en geeft meteen toestemming om het met de partner door te
    // spreken. Dat laatste is het vinkje dat hieronder al stond.
    function pasTekstenAan(source) {
      huidigeBron = source || "";
      adviesModus = source === "advies_partner";
      rapportModus = source === "volledig_rapport";
      const partner = (tenantData && tenantData.adviesPartner) || "onze partner";
      if (titleEl) {
        titleEl.textContent = adviesModus
          ? "Vrijblijvend advies van " + partner
          : rapportModus
            ? "Volledig rapport aanvragen"
            : origineel.title;
      }
      if (leadEl) {
        leadEl.innerHTML = adviesModus
          ? "Gratis extra dienst: de specialisten van " + partner + " zetten dit rapport om in concrete maatregelen en nemen de uitvoering volledig uit handen. Laat uw gegevens achter; zij ontvangen het snelle rapport en nemen contact met u op. De financiering regelt u met uw hypotheekadviseur."
          : rapportModus
            // GEEN PARTNERNAAM IN DEZE ZIN (Dennis, 23 oktober 2026).
            // Dit is het bestelvenster van het rapport, niet de adviesaanvraag:
            // de bezoeker koopt hier iets van de tenant, en de naam van de
            // opvolgpartner leidt daarvan af. Hij staat wel in de
            // toestemmingstekst bij het vinkje zelf, en daar hoort hij ook:
            // instemming met doorgifte vraagt dat je weet aan wie.
            ? "Het volledige rapport gaat per e-mail naar u toe: de passende maatregelen, de volgorde, de kosten, de subsidies en wat het met uw woningwaarde doet. Met het vinkje hieronder mag een specialist van onze verduurzamingspartner het rapport met u doornemen."
            : origineel.lead;
      }
      if (successBox) {
        successBox.textContent = adviesModus
          ? "Bedankt! Uw aanvraag en het rapport zijn verstuurd naar " + partner + ". Zij nemen zo spoedig mogelijk contact met u op."
          : rapportModus
            ? "Bedankt! Het volledige rapport wordt gemaakt en komt binnen enkele minuten per e-mail binnen."
            : origineel.success;
      }
      if (submitBtn) {
        submitBtn.textContent = adviesModus
          ? "Advies aanvragen"
          : rapportModus
            ? "Rapport aanvragen"
            : origineel.submit;
      }
    }

    // Toestemmingsvinkje voor de lead.
    //
    // De tekst komt van de runtime (/api/tenant), met de partnernaam er al in
    // verwerkt. Zo staat die zin op een plek in plaats van in vier kopieen van dit
    // bestand -- dezelfde reden als bij het gedeelde rapportprofiel.
    //
    // Zonder vinkje gaat de lead nog steeds als mail naar de partner; alleen de
    // centrale database krijgt hem niet, want die weigert een lead zonder
    // vastgelegde instemming. Lukt het ophalen niet, dan verandert er dus niets aan
    // wat de bezoeker kan: het formulier blijft werken.
    let akkoordVak = null;
    (async function plaatsToestemming() {
      try {
        const tenant = await haalTenant();
        // De naam van de partner komt uit diezelfde gegevens. Stond het venster al
        // open voordat ze binnen waren, dan stond er "onze partner"; nu niet meer.
        if (adviesModus) pasTekstenAan(huidigeBron);
        const tekst = tenant && tenant.lead && tenant.lead.tekst;
        if (!tekst || form.querySelector("[data-contact-akkoord]")) return;

        const rij = document.createElement("label");
        rij.setAttribute("data-contact-akkoord-rij", "");
        rij.style.cssText = "display:flex;gap:.5rem;align-items:flex-start;margin:.75rem 0;font-size:.875rem;line-height:1.4;";
        const vak = document.createElement("input");
        vak.type = "checkbox";
        // OPTIONEEL, en dat is het hele punt.
        //
        // Dit vinkje stond op `required`, terwijl de tekst om iets heel anders
        // vraagt dan om het rapport te mogen maken: toestemming om je gegevens
        // aan de opvolgpartner te geven. Je kon het volledige rapport dus niet
        // krijgen zonder die doorgifte te accepteren. Toestemming die je moet
        // geven om de dienst te krijgen is geen vrije toestemming, en de
        // privacyverklaring beloofde het tegendeel: "opvolging -- alleen als u
        // daar toestemming voor geeft".
        //
        // Het rapport zelf hangt hier niet aan: dat loopt via een eigen
        // aanroep (/api/internal/full/render) die het formulier na het
        // versturen doet. Zonder vinkje krijgt de bezoeker dus gewoon zijn
        // rapport, en gaat er niets naar de partner -- zie de advies_aanvraag-
        // route in index.js, die de partnermail sinds 18 oktober 2026 aan deze
        // instemming koppelt.
        vak.required = false;
        vak.setAttribute("data-contact-akkoord", "");
        // MAAT EXPLICIET, want de tenant-stylesheets zetten `input { width:100% }`
        // voor de formuliervelden. Zonder deze regel werd het vinkje even breed
        // als de hele rij (gemeten: 500 px) en werd de tekst ernaast tot een
        // kolom van een letter breed geperst. `flex:0 0 auto` helpt daar niet
        // tegen: dat regelt het groeien en krimpen, niet de breedte zelf.
        vak.style.cssText = "margin-top:.2rem;flex:0 0 auto;width:18px;height:18px;";
        const span = document.createElement("span");
        span.style.cssText = "flex:1 1 auto;min-width:0;";
        // "Optioneel:" VOORAAN, niet achteraan. Een vinkje dat verplicht oogt
        // wordt "voor de zekerheid" aangezet, en dan is de toestemming net zo
        // min vrij gegeven als toen hij echt verplicht was. Achteraan belandde
        // het woord bovendien tussen de slotzin en de privacylink in
        // ("... zie de privacyverklaring. (optioneel) Privacyverklaring"), en
        // dat leest als een voetnoot in plaats van als de kern.
        const tekstMetHint = `Optioneel: ${tekst.charAt(0).toLowerCase()}${tekst.slice(1)}`;
        span.textContent = tekstMetHint;
        if (tenant.lead.privacyUrl) {
          span.textContent = tekstMetHint + " ";
          const a = document.createElement("a");
          a.href = tenant.lead.privacyUrl;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = "Privacyverklaring";
          span.appendChild(a);
        }
        rij.appendChild(vak);
        rij.appendChild(span);
        // BOVEN DE KNOPPENRIJ, NIET ERIN.
        //
        // Dit zette de regel vlak voor de verstuurknop, en die staat in
        // .contactModal__actions -- een flexrij met de knoppen rechts. Een
        // zin van twee regels komt daar tussen de twee knoppen te staan, en
        // omdat een flexrij zijn kinderen even hoog maakt, rekten "Annuleren"
        // en "Versturen" mee tot blokken van ruim 200 pixels, met de tekst
        // eroverheen en een horizontale schuifbalk eronder. Live gezien op de
        // Softbee-pagina, 22 oktober 2026.
        //
        // De toestemming hoort boven de knoppen: je leest hem voordat je
        // verstuurt.
        const acties = (submitBtn && submitBtn.closest(".contactModal__actions")) || null;
        if (acties && acties.parentNode) acties.parentNode.insertBefore(rij, acties);
        else if (submitBtn && submitBtn.parentNode) submitBtn.parentNode.insertBefore(rij, submitBtn);
        else form.appendChild(rij);
        akkoordVak = vak;
      } catch (_) {
        // Geen vinkje: de lead gaat dan alleen als mail, zoals voorheen.
      }
    })();

    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      errorBox?.setAttribute("hidden", "");
      successBox?.setAttribute("hidden", "");

      const data = {
        firstName: (form.firstName?.value || "").trim(),
        lastName:  (form.lastName?.value  || "").trim(),
        email:     (form.email?.value     || "").trim(),
        phone:     (form.phone?.value     || "").trim(),
        message:   (form.message?.value   || "").trim(),
        sourcePage: (form.sourcePage?.value || ""),
        // Honeypot — real users should leave this empty. Bots fill all fields.
        website:   (form.website?.value   || ""),
        // Optional report context. Each page populates window.__leadContext
        // with whatever it has: mid_report sends the rendered report HTML
        // + confirmed data, full_start sends partial form data, full_done
        // sends just the order_id (server enriches the rest).
        context: (typeof window.__leadContext === "object" && window.__leadContext) ? window.__leadContext : null,
        // Alleen true als de bezoeker het vinkje werkelijk aanzette. De runtime
        // meldt de lead zonder dit niet bij de centrale database.
        akkoord: akkoordVak ? akkoordVak.checked === true : false,
      };

      // Quick client-side checks. Server validates again.
      const missing = [];
      if (!data.firstName) missing.push("Voornaam");
      if (!data.lastName)  missing.push("Achternaam");
      if (!data.email || !/^\S+@\S+\.\S+$/.test(data.email)) missing.push("E-mailadres");
      if (!data.phone || data.phone.replace(/\D/g, "").length < 6) missing.push("Telefoonnummer");
      if (missing.length) {
        if (errorBox) {
          errorBox.textContent = "Controleer de volgende velden: " + missing.join(", ") + ".";
          errorBox.removeAttribute("hidden");
        }
        return;
      }
      if (data.message.length > MAX_MESSAGE) {
        if (errorBox) {
          errorBox.textContent = "Opmerkingen mogen maximaal " + MAX_MESSAGE + " tekens bevatten.";
          errorBox.removeAttribute("hidden");
        }
        return;
      }

      submitBtn?.setAttribute("disabled", "");
      const originalLabel = submitBtn?.textContent;
      if (submitBtn) submitBtn.textContent = "Versturen…";

      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        const json = await res.json().catch(function () { return null; });
        if (!res.ok || !json || json.ok !== true) {
          const detail = json?.error || ("HTTP " + res.status);
          throw new Error(detail);
        }
        // Success.
        form.reset();
        if (counter) counter.textContent = "0/" + MAX_MESSAGE;
        // Hide everything except the success box so the user gets a clean
        // confirmation. The form is restored next time the modal opens.
        $$(modal, ".contactModal__sectionLabel, .contactModal__grid, .contactModal__field, .contactModal__actions").forEach(function (el) {
          el.style.display = "none";
        });
        // Also collapse the lead paragraph so the modal feels resolved.
        const leadP = $(modal, ".contactModal__lead");
        if (leadP) leadP.style.display = "none";
        successBox?.removeAttribute("hidden");
        notifyHeightChange();
        // De pagina mag hierna nog iets doen met dezelfde gegevens -- bij
        // "volledig_rapport" is dat het aanmaken van de bestelling. Een
        // gebeurtenis en geen terugroep: dit bestand is gedeeld, en een
        // tenant die niets meeluistert hoort er niets van te merken.
        try {
          document.dispatchEvent(new CustomEvent("contact-lead-verstuurd", {
            detail: { bron: huidigeBron, gegevens: data, antwoord: json },
          }));
        } catch (_) {}
      } catch (err) {
        if (errorBox) {
          // Het terugvaladres stond hier per tenant hardgecodeerd; nu komt het uit
          // /api/tenant, zodat dit bestand voor iedereen hetzelfde kan zijn.
          var tenantMail = (tenantData && tenantData.contact && tenantData.contact.email) || "";
          errorBox.textContent = "Versturen mislukt: " + (err?.message || "onbekende fout") +
            (tenantMail ? ". Probeer het later opnieuw of mail rechtstreeks naar " + tenantMail + "." : ". Probeer het later opnieuw.");
          errorBox.removeAttribute("hidden");
        }
      } finally {
        submitBtn?.removeAttribute("disabled");
        if (submitBtn && originalLabel) submitBtn.textContent = originalLabel;
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
