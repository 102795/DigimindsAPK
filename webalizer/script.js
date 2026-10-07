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
    "Paginatitel ontbreekt": "Schrijf een unieke titel die vertelt wat bezoekers op deze pagina vinden.",
    "Meta description ontbreekt": "Schrijf een korte samenvatting van de inhoud van deze pagina.",
    "Geen H1-kop gevonden": "Voeg bovenaan een duidelijke hoofdkop toe die het onderwerp benoemt.",
    "Meerdere H1-koppen gevonden": "Controleer de koppenstructuur en maak duidelijk welke kop het hoofdonderwerp is.",
    "Afbeeldingen zonder alt-tekst": "Beschrijf betekenisvolle afbeeldingen kort in alt-tekst. Decoratieve afbeeldingen kunnen een lege alt-tekst krijgen.",
    "Website gebruikt geen HTTPS": "Stel HTTPS in bij je hostingprovider en stuur bezoekers door naar de beveiligde versie.",
    "Paginatitel gevonden": "Controleer of de titel specifiek is voor deze pagina en goed leesbaar is.",
    "Meta description gevonden": "Controleer of de samenvatting de inhoud van de pagina goed beschrijft.",
    "Eén H1-kop gevonden": "Zorg dat de hoofdkop bezoekers snel vertelt waar de pagina over gaat.",
    "Alt-attributen gevonden": "Controleer of alt-teksten de inhoud of functie van afbeeldingen beschrijven.",
    "HTTPS actief": "Controleer regelmatig of het HTTPS-certificaat geldig blijft."
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
