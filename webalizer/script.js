// Pak de onderdelen van de pagina die JavaScript nodig heeft.
const form = document.querySelector("#scan-form");
const button = document.querySelector("#scan-button");
const message = document.querySelector("#message");
const result = document.querySelector("#result");

// Stuur de ingevulde URL naar Python wanneer het formulier wordt verstuurd.
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  result.replaceChildren();
  message.textContent = "We bekijken de pagina...";
  button.disabled = true;

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: document.querySelector("#url").value.trim() })
    });
    const data = await response.json();

    if (!response.ok) throw new Error(data.error || "De scan is mislukt");
    showReport(data);
    message.textContent = "Analyse afgerond — hieronder staan je resultaten.";
  } catch (error) {
    message.textContent = `${error.message} Controleer of de Python-server draait.`;
  } finally {
    button.disabled = false;
  }
});

// Koppel een scanresultaat aan een praktische tip.
function recommendationFor(title) {
  const tips = {
    // Slechte en middelmatige punten.
    "Paginatitel ontbreekt": "Schrijf een unieke titel die vertelt wat bezoekers op deze pagina vinden.",
    "Paginatitel heeft een slechte lengte": "Houd de titel tussen 30 en 60 tekens, zodat hij compleet in Google past.",
    "Meta description ontbreekt": "Schrijf een korte samenvatting van de inhoud van deze pagina.",
    "Meta description heeft een slechte lengte": "Houd de description tussen 70 en 160 tekens.",
    "Geen H1-kop gevonden": "Voeg bovenaan een duidelijke hoofdkop toe die het onderwerp benoemt.",
    "Meerdere H1-koppen gevonden": "Gebruik één H1 en maak van de andere koppen H2 of H3.",
    "Koppenvolgorde klopt niet": "Ga stap voor stap: H1, dan H2, dan H3. Sla geen niveaus over.",
    "Afbeeldingen zonder alt-tekst": "Beschrijf betekenisvolle afbeeldingen kort in alt-tekst. Decoratieve afbeeldingen kunnen een lege alt-tekst krijgen.",
    "Afbeeldingen zonder afmetingen": "Voeg width en height toe aan elke afbeelding, zodat de pagina niet verspringt tijdens het laden.",
    "Website gebruikt geen HTTPS": "Stel HTTPS in bij je hostingprovider en stuur bezoekers door naar de beveiligde versie.",
    "Mixed content gevonden": "Wijzig alle http://-links van afbeeldingen, scripts en stijlen naar https://.",
    "Pagina staat op noindex": "Verwijder noindex uit de robots meta-tag als de pagina in Google moet verschijnen.",
    "Doctype ontbreekt": "Begin je HTML-bestand met <!doctype html>.",
    "Tekenset ontbreekt": "Voeg <meta charset=\"utf-8\"> toe bovenin de head.",
    "Taalattribuut ontbreekt": "Voeg lang=\"nl\" toe aan de html-tag.",
    "Viewport-tag ontbreekt": "Voeg <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> toe in de head.",
    "Canonical-link ontbreekt": "Voeg <link rel=\"canonical\" href=\"...\"> toe met de voorkeurs-URL van de pagina.",
    "Open Graph-titel ontbreekt": "Voeg <meta property=\"og:title\" content=\"...\"> toe voor een nette weergave op social media.",
    "Open Graph-beschrijving ontbreekt": "Voeg <meta property=\"og:description\" content=\"...\"> toe.",
    "Open Graph-afbeelding ontbreekt": "Voeg <meta property=\"og:image\" content=\"https://...\"> toe met een afbeelding van minimaal 1200x630 pixels.",
    "Twitter Card ontbreekt": "Voeg <meta name=\"twitter:card\" content=\"summary_large_image\"> toe.",
    "Gestructureerde data ontbreekt": "Voeg JSON-LD toe (zoals Organization of Article) zodat zoekmachines je pagina beter begrijpen.",
    "Favicon ontbreekt": "Voeg een favicon toe met <link rel=\"icon\" href=\"/favicon.ico\">.",
    "robots.txt ontbreekt": "Maak een robots.txt in de hoofdmap van je website.",
    "sitemap.xml ontbreekt": "Maak een sitemap.xml en verwijs ernaar in je robots.txt.",
    "Vage linkteksten gevonden": "Vervang 'klik hier' door een tekst die zegt waar de link naartoe gaat.",
    "Links openen onveilig in nieuw tabblad": "Voeg rel=\"noopener noreferrer\" toe aan links met target=\"_blank\".",
    "Weinig tekst op de pagina": "Voeg meer nuttige inhoud toe. Minimaal 300 woorden helpt zoekmachines de pagina te begrijpen.",
    "Scripts blokkeren het laden": "Voeg defer of async toe aan scripts in de head.",
    "Beveiligingsheaders ontbreken": "Stel de ontbrekende headers in op je server of hostingprovider.",
    "Serverinformatie lekt": "Verwijder de X-Powered-By header, zodat aanvallers je techniek niet zien.",
    "Compressie ontbreekt": "Zet gzip of brotli aan op je server of hostingprovider.",
    "Cache-Control ontbreekt": "Stel Cache-Control in, zodat bezoekers de pagina sneller opnieuw laden.",
    "HTML is groot": "Verklein de HTML: verwijder ongebruikte code en laad grote delen later.",
    "HTML is erg groot": "Verklein de HTML sterk: verwijder ongebruikte code en laad grote delen later.",
    "Te veel doorverwijzingen": "Verwijs direct naar de eindpagina in plaats van via meerdere stappen.",
    "Meerdere doorverwijzingen": "Probeer het aantal redirects terug te brengen tot maximaal één.",
    "Trage serverreactie": "Gebruik caching, een snellere hosting of een CDN.",

    // Goede punten.
    "Paginatitel gevonden": "Controleer of de titel specifiek is voor deze pagina.",
    "Meta description gevonden": "Controleer of de samenvatting de inhoud goed beschrijft.",
    "Eén H1-kop gevonden": "Zorg dat de hoofdkop bezoekers snel vertelt waar de pagina over gaat.",
    "Koppenvolgorde klopt": "Houd de koppenstructuur logisch bij nieuwe inhoud.",
    "Alt-attributen gevonden": "Controleer of alt-teksten de inhoud of functie van afbeeldingen beschrijven.",
    "Afbeeldingen hebben afmetingen": "Voeg bij nieuwe afbeeldingen ook width en height toe.",
    "HTTPS actief": "Controleer regelmatig of het HTTPS-certificaat geldig blijft.",
    "Geen mixed content": "Blijf nieuwe onderdelen altijd via https:// toevoegen.",
    "Pagina mag worden geïndexeerd": "Controleer dat dit ook bedoeld is voor alle belangrijke pagina's.",
    "Gestructureerde data gevonden": "Test de JSON-LD met de Rich Results Test van Google.",
    "Favicon gevonden": "Controleer of de favicon er goed uitziet op kleine formaten.",
    "robots.txt gevonden": "Controleer dat robots.txt geen belangrijke pagina's blokkeert.",
    "sitemap.xml gevonden": "Houd de sitemap up-to-date als je pagina's toevoegt.",
    "Beveiligingsheaders aanwezig": "Controleer af en toe of de headers nog goed zijn ingesteld.",
    "Compressie actief": "Controleer dat ook CSS en JavaScript gecomprimeerd worden.",
    "Snelle serverreactie": "Houd de reactietijd in de gaten als de website groeit."
  };

  return tips[title] || "Controleer deze bevinding en kijk of een aanpassing past bij het doel van je pagina.";
}
// Bouw de score, bevindingen en adviezen op de pagina op.
function showReport(data) {
  const summary = document.createElement("div");
  summary.className = "summary";

  const score = document.createElement("div");
  score.className = "score";
  score.textContent = `${data.score}/100`;

  const facts = document.createElement("p");
  facts.textContent = `${data.url} · HTTP ${data.status} · ${data.counts.links} links · ${data.counts.images} afbeeldingen`;
  summary.append(score, facts);
  result.append(summary);

  const heading = document.createElement("h2");
  heading.className = "section-title";
  heading.textContent = "Wat we hebben gevonden";
  result.append(heading);

  // Maak voor elke bevinding een kaart met uitleg en advies.
  for (const finding of data.findings) {
    const card = document.createElement("article");
    card.className = `finding ${finding.level}`;

    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = finding.level === "good" ? "✓" : "!";

    const content = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = finding.title;

    const detail = document.createElement("p");
    detail.textContent = finding.detail;

    const advice = document.createElement("p");
    advice.className = "advice";
    advice.textContent = `Advies: ${recommendationFor(finding.title)}`;

    content.append(title, detail, advice);
    card.append(icon, content);
    result.append(card);
  }

  const notice = document.createElement("p");
  notice.className = "notice";
  notice.textContent = data.notice;
  result.append(notice);
}
