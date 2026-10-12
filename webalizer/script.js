// Pak de onderdelen van de pagina die JavaScript nodig heeft.
const form = document.querySelector("#scan-form");
const button = document.querySelector("#scan-button");
const message = document.querySelector("#message");
const result = document.querySelector("#result");
let latestReport = null;

// Vraag een mobiele Lighthouse-scan aan bij de Node-server.
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  result.replaceChildren();
  latestReport = null;
  message.textContent = "Google Lighthouse analyseert de website... Dit kan even duren.";
  button.disabled = true;

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: document.querySelector("#url").value.trim() }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "De Lighthouse-scan is mislukt.");

    latestReport = data;
    showReport(data);
    message.textContent = "Lighthouse-scan afgerond — hieronder staan je resultaten.";
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

// Bouw de score, categorieën en Lighthouse-verbeterpunten op de pagina op.
function showReport(data) {
  const scoreValue = Math.max(0, Math.min(100, Number(data.score) || 0));

  const scoreBar = document.createElement("section");
  scoreBar.className = "site-score-bar";
  scoreBar.setAttribute("aria-label", `Gemiddelde Lighthouse-score: ${scoreValue} van de 100`);
  scoreBar.innerHTML =
    '<div class="site-score-bar__label"><strong>Gemiddelde website-score</strong><span><b></b> / 100</span></div>' +
    '<div class="site-score-bar__track" role="progressbar" aria-label="Gemiddelde website-score" aria-valuemin="0" aria-valuemax="100"><span></span></div>';
  scoreBar.querySelector(".site-score-bar__label b").textContent = scoreValue;
  const track = scoreBar.querySelector(".site-score-bar__track");
  track.setAttribute("aria-valuenow", scoreValue);
  result.append(scoreBar);

  const scoreNote = document.createElement("p");
  scoreNote.className = "lighthouse-note";
  scoreNote.textContent = "Gemiddelde van snelheid, toegankelijkheid, veilig bouwen en vindbaarheid op mobiel.";
  result.append(scoreNote);

  requestAnimationFrame(() => {
    const fill = scoreBar.querySelector(".site-score-bar__track span");
    if (fill) fill.style.width = `${scoreValue}%`;
  });

  const categoryHeading = document.createElement("h2");
  categoryHeading.className = "section-title";
  categoryHeading.textContent = "Scores per onderdeel";
  result.append(categoryHeading);

  const categoryGrid = document.createElement("div");
  categoryGrid.className = "lighthouse-categories";
  for (const category of data.categories || []) {
    const card = document.createElement("article");
    card.className = "lighthouse-category";

    const title = document.createElement("h3");
    title.textContent = category.title;

    const value = document.createElement("strong");
    value.textContent = `${category.score}/100`;

    const meter = document.createElement("div");
    meter.className = "lighthouse-category__track";
    meter.setAttribute("role", "progressbar");
    meter.setAttribute("aria-label", `${category.title}-score`);
    meter.setAttribute("aria-valuemin", "0");
    meter.setAttribute("aria-valuemax", "100");
    meter.setAttribute("aria-valuenow", category.score);
    const fill = document.createElement("span");
    fill.style.width = `${category.score}%`;
    meter.append(fill);

    card.append(title, value, meter);
    categoryGrid.append(card);
  }
  result.append(categoryGrid);

  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.className = "download-report";
  downloadButton.textContent = "Download rapport als PDF";
  downloadButton.addEventListener("click", downloadReport);
  result.append(downloadButton);

  const strengthsHeading = document.createElement("h2");
  strengthsHeading.className = "section-title";
  strengthsHeading.textContent = "Wat gaat al goed";
  result.append(strengthsHeading);

  const strengths = data.strengths || [];
  if (strengths.length === 0) {
    const empty = document.createElement("p");
    empty.className = "notice";
    empty.textContent = "Lighthouse heeft geen positieve controles voor deze scan gerapporteerd.";
    result.append(empty);
  }

  for (const strength of strengths) {
    const card = document.createElement("article");
    card.className = "finding good";

    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = "✓";

    const content = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = strength.title;

    const detail = document.createElement("p");
    detail.textContent = strength.detail;

    content.append(title, detail);
    card.append(icon, content);
    result.append(card);
  }

  const heading = document.createElement("h2");
  heading.className = "section-title";
  heading.textContent = "Wat kan beter";
  result.append(heading);

  const findings = data.findings || [];
  if (findings.length === 0) {
    const empty = document.createElement("p");
    empty.className = "notice";
    empty.textContent = "Lighthouse heeft geen verbeterpunten voor deze scan gerapporteerd.";
    result.append(empty);
  }

  for (const finding of findings) {
    const card = document.createElement("article");
    card.className = `finding ${finding.level}`;

    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = finding.level === "high" ? "!" : "↗";

    const content = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = finding.title;

    const detail = document.createElement("p");
    detail.textContent = finding.detail;
    content.append(title, detail);

    if (finding.advice) {
      const advice = document.createElement("p");
      advice.className = "advice";
      advice.textContent = `Advies: ${finding.advice}`;
      content.append(advice);
    }

    card.append(icon, content);
    result.append(card);
  }

  const notice = document.createElement("p");
  notice.className = "notice";
  notice.textContent = data.notice;
  result.append(notice);
}

// Vraag de server om een PDF en start de download in de browser.
async function downloadReport() {
  const downloadButton = result.querySelector(".download-report");
  if (!latestReport || !downloadButton) return;

  downloadButton.disabled = true;
  downloadButton.textContent = "PDF wordt gemaakt...";
  try {
    const response = await fetch("/api/report.pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(latestReport),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "Het PDF-rapport kon niet worden gemaakt.");
    }

    const pdf = await response.blob();
    const downloadUrl = URL.createObjectURL(pdf);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = "lighthouse-rapport.pdf";
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(downloadUrl);
  } catch (error) {
    message.textContent = error.message;
  } finally {
    downloadButton.disabled = false;
    downloadButton.textContent = "Download rapport als PDF";
  }
}
