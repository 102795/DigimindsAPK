// Importeer de ingebouwde Node-onderdelen (geen extra pakketten nodig).
const http = require("http");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");
const PDFDocument = require("pdfkit");
require("dotenv").config({ path: path.join(__dirname, ".env") });

// De server is alleen bereikbaar op deze computer.
const HOST = "127.0.0.1";
const PORT = 8000;
const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 5;

// Toegestane bestandstypen. Alles met deze extensies in de map wordt geleverd.
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

// Controleer of een IP-adres openbaar is (niet lokaal of privé).
function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a >= 224) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return false;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return false;
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return false;
    if (lower.startsWith("::ffff:")) return isPublicIp(lower.slice(7));
    return true;
  }
  return false;
}

// Controleer of de invoer een volledige HTTP- of HTTPS-URL is en of het adres openbaar is.
async function validatePublicUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Vul een volledig adres in, bijvoorbeeld https://voorbeeld.nl");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error("Vul een volledig adres in, bijvoorbeeld https://voorbeeld.nl");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URL's met gebruikersnaam of wachtwoord zijn niet toegestaan");
  }

  // Zoek de IP-adressen op en blokkeer lokale/private adressen.
  let addresses;
  try {
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new Error("De website kon niet worden gevonden");
  }
  for (const { address } of addresses) {
    if (!isPublicIp(address)) {
      throw new Error("Lokale en niet-publieke adressen zijn niet toegestaan");
    }
  }
  return parsed.href;
}

// Haal de pagina op, controleer elke redirect en meet de reactietijd.
async function fetchPage(startUrl) {
  let current = await validatePublicUrl(startUrl);

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const startTime = performance.now();
    const response = await fetch(current, {
      redirect: "manual",
      headers: { "User-Agent": "SiteScan/1.0" },
      signal: AbortSignal.timeout(12000),
    });
    const ms = Math.round(performance.now() - startTime);

    // Bij een redirect: valideer de nieuwe URL en probeer opnieuw.
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Ongeldige doorverwijzing");
      current = await validatePublicUrl(new URL(location, current).href);
      continue;
    }

    // Deze versie analyseert alleen HTML-pagina's.
    const contentType = response.headers.get("content-type") || "";
    const mime = contentType.split(";")[0].trim().toLowerCase();
    if (mime !== "text/html" && mime !== "application/xhtml+xml") {
      throw new Error("Deze URL geeft geen HTML-pagina terug");
    }

    // Beperk de hoeveelheid data die de tool downloadt.
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > MAX_BYTES) {
        throw new Error("De pagina is groter dan de scanlimiet van 1,5 MB");
      }
      chunks.push(chunk);
    }

    // Decodeer de tekst met de juiste tekenset.
    const charsetMatch = /charset=([^;]+)/i.exec(contentType);
    let html;
    try {
      html = new TextDecoder(charsetMatch ? charsetMatch[1].trim() : "utf-8").decode(Buffer.concat(chunks));
    } catch {
      html = Buffer.concat(chunks).toString("utf-8");
    }
    return {
      html,
      status: response.status,
      finalUrl: current,
      headers: response.headers,
      ms,
      bytes: total,
      redirects: i,
      headerCharset: Boolean(charsetMatch),
    };
  }
  throw new Error("Te veel doorverwijzingen");
}

// Controleer of een bestand (zoals robots.txt) bestaat op dezelfde website.
async function fileExists(base, filePath) {
  try {
    const response = await fetch(new URL(filePath, base).href, {
      redirect: "manual",
      headers: { "User-Agent": "SiteScan/1.0" },
      signal: AbortSignal.timeout(6000),
    });
    const type = response.headers.get("content-type") || "";
    response.body?.cancel();
    // Een HTML-antwoord is meestal een nette 404-pagina en telt dus niet mee.
    return response.status === 200 && !/text\/html/i.test(type);
  } catch {
    return false;
  }
}

// Lees de attributen uit een tag, bijvoorbeeld alt="tekst".
function parseAttributes(tag) {
  const attrs = {};
  const regex = /([^\s=\/<>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = regex.exec(tag.replace(/^<\w+/, ""))) !== null) {
    attrs[match[1].toLowerCase()] = (match[2] ?? match[3] ?? match[4] ?? "").trim();
  }
  return attrs;
}

// Lees de feiten uit de HTML.
function readFacts(html) {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";

  // Meta-tags: description, viewport, robots, charset, Open Graph en Twitter.
  let description = "";
  let robots = "";
  let hasViewport = false;
  let hasMetaCharset = false;
  const og = { title: false, description: false, image: false };
  let hasTwitterCard = false;
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = parseAttributes(tag);
    const name = (attrs.name || "").toLowerCase();
    const property = (attrs.property || "").toLowerCase();
    if (name === "description") description = attrs.content || "";
    if (name === "robots") robots = (attrs.content || "").toLowerCase();
    if (name === "viewport") hasViewport = true;
    if (name === "twitter:card" && attrs.content) hasTwitterCard = true;
    if (attrs.charset !== undefined) hasMetaCharset = true;
    if ((attrs["http-equiv"] || "").toLowerCase() === "content-type") hasMetaCharset = true;
    if (property === "og:title" && attrs.content) og.title = true;
    if (property === "og:description" && attrs.content) og.description = true;
    if (property === "og:image" && attrs.content) og.image = true;
  }

  // Link-tags: canonical, favicon en onveilige stylesheets.
  let hasCanonical = false;
  let hasIconLink = false;
  let insecureResources = 0;
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const attrs = parseAttributes(tag);
    const rel = (attrs.rel || "").toLowerCase();
    if (rel === "canonical" && attrs.href) hasCanonical = true;
    if (rel.includes("icon")) hasIconLink = true;
    if (rel === "stylesheet" && (attrs.href || "").startsWith("http://")) insecureResources++;
  }

  // Afbeeldingen, scripts en iframes die via onveilig HTTP laden.
  for (const tag of html.match(/<(?:img|script|iframe)\b[^>]*>/gi) || []) {
    if ((parseAttributes(tag).src || "").startsWith("http://")) insecureResources++;
  }

  // Scripts in de head zonder async of defer blokkeren het laden van de pagina.
  const headMatch = /<head[\s\S]*?<\/head>/i.exec(html);
  let blockingScripts = 0;
  for (const tag of (headMatch ? headMatch[0] : "").match(/<script\b[^>]*>/gi) || []) {
    const attrs = parseAttributes(tag);
    const type = (attrs.type || "").toLowerCase();
    if (attrs.src && attrs.async === undefined && attrs.defer === undefined && type !== "module") blockingScripts++;
  }

  // Gestructureerde data (JSON-LD) voor zoekmachines.
  const hasJsonLd = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json/i.test(html);

  // Taal, doctype en tekens.
  const langMatch = /<html\b[^>]*\blang\s*=\s*["']?([a-zA-Z-]+)/i.exec(html);
  const lang = langMatch ? langMatch[1] : "";
  const hasDoctype = /^\s*(?:<!--[\s\S]*?-->\s*)*<!doctype html/i.test(html);

  // Koppen: aantal H1 en sprongen in de volgorde (bijvoorbeeld H1 naar H3).
  const h1Count = (html.match(/<h1[\s>]/gi) || []).length;
  const levels = [...html.matchAll(/<h([1-6])[\s>]/gi)].map((m) => Number(m[1]));
  let headingJumps = 0;
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] - levels[i - 1] > 1) headingJumps++;
  }

  // Afbeeldingen: alt-tekst en vaste afmetingen (voorkomt verspringende pagina's).
  const imgTags = (html.match(/<img\b[^>]*>/gi) || []).map(parseAttributes);
  const images = imgTags.map((attrs) => attrs.alt || "");
  const imagesWithoutSize = imgTags.filter((a) => !(a.width && a.height)).length;

  // Links: aantal, vage linkteksten en target="_blank" zonder rel.
  const vague = ["klik hier", "hier", "lees meer", "meer", "meer info", "click here", "read more", "more"];
  let vagueLinks = 0;
  let unsafeBlank = 0;
  let linkCount = 0;
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = parseAttributes("<a " + match[1]);
    if (!attrs.href) continue;
    linkCount++;
    const text = match[2].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    if (vague.includes(text)) vagueLinks++;
    if ((attrs.target || "").toLowerCase() === "_blank" && !/noopener|noreferrer/i.test(attrs.rel || "")) unsafeBlank++;
  }

  // Aantal woorden in de zichtbare tekst.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  const wordCount = (text.match(/[\p{L}\p{N}'-]+/gu) || []).length;

  return {
    title, description, robots, h1Count, images, imagesWithoutSize, lang, hasViewport, hasMetaCharset,
    hasCanonical, hasIconLink, og, hasTwitterCard, hasJsonLd, hasDoctype, insecureResources,
    blockingScripts, headingJumps, vagueLinks, unsafeBlank, wordCount, linkCount,
  };
}

// Voer alle controles uit en maak het rapport.
async function analyzeLegacy(url) {
  const page = await fetchPage(url);
  const { html, status, finalUrl, headers, ms, bytes, redirects, headerCharset } = page;
  const facts = readFacts(html);
  const isHttps = new URL(finalUrl).protocol === "https:";

  // Controleer ook robots.txt, sitemap.xml en favicon.ico tegelijk.
  const [hasRobots, hasSitemap, hasFaviconFile] = await Promise.all([
    fileExists(finalUrl, "/robots.txt"),
    fileExists(finalUrl, "/sitemap.xml"),
    facts.hasIconLink ? Promise.resolve(true) : fileExists(finalUrl, "/favicon.ico"),
  ]);

  const findings = [];

  // Sla één controle op. Weight bepaalt hoe zwaar de controle meetelt.
  const add = (level, title, detail, weight = 1) => findings.push({ level, title, detail, weight });

  // Titel: aanwezig en tussen 30 en 60 tekens.
  const titleLength = facts.title.length;
  if (!titleLength) {
    add("high", "Paginatitel ontbreekt", "Er is geen paginatitel gevonden.", 3);
  } else if (titleLength < 30 || titleLength > 60) {
    add("medium", "Paginatitel heeft een slechte lengte", `${titleLength} tekens (ideaal: 30 tot 60): ${facts.title.slice(0, 120)}`, 3);
  } else {
    add("good", "Paginatitel gevonden", facts.title, 3);
  }

  // Meta description: aanwezig en tussen 70 en 160 tekens
  const descLength = facts.description.length;
  if (!descLength) {
    add("medium", "Meta description ontbreekt", "Er is geen meta description gevonden.", 2);
  } else if (descLength < 70 || descLength > 160) {
    add("low", "Meta description heeft een slechte lengte", `${descLength} tekens (ideaal: 70 tot 160).`, 2);
  } else {
    add("good", "Meta description gevonden", facts.description, 2);
  }

  // Hoofdkoppen: precies één H1
  if (facts.h1Count === 0) add("medium", "Geen H1-kop gevonden", "Er is geen H1-hoofdkop gevonden.", 2);
  else if (facts.h1Count > 1) add("low", "Meerdere H1-koppen gevonden", `Er zijn ${facts.h1Count} H1-koppen gevonden.`, 2);
  else add("good", "Eén H1-kop gevonden", "Er is één H1-hoofdkop gevonden.", 2);

  // Volgorde van koppen: geen sprongen zoals H1 naar H3.
  if (facts.headingJumps > 0) add("low", "Koppenvolgorde klopt niet", `${facts.headingJumps} keer wordt een kopniveau overgeslagen.`);
  else add("good", "Koppenvolgorde klopt", "Er worden geen kopniveaus overgeslagen.");

  // Alt-teksten: elke afbeelding moet een alt-attribuut hebben.
  const missingAlt = facts.images.filter((alt) => !alt).length;
  if (facts.images.length === 0) {
    add("good", "Geen afbeeldingen gevonden", "Er zijn geen img-elementen gevonden.");
  } else if (missingAlt) {
    add("medium", "Afbeeldingen zonder alt-tekst", `${missingAlt} van de ${facts.images.length} afbeeldingen hebben geen alt-tekst.`, 2);
  } else {
    add("good", "Alt-attributen gevonden", `Alle ${facts.images.length} afbeeldingen hebben een alt-attribuut.`, 2);
  }

  // Afbeeldingen met breedte en hoogte voorkomen dat de pagina verspringt.
  if (facts.images.length > 0) {
    if (facts.imagesWithoutSize > 0) {
      add("low", "Afbeeldingen zonder afmetingen", `${facts.imagesWithoutSize} van de ${facts.images.length} afbeeldingen hebben geen width en height.`);
    } else {
      add("good", "Afbeeldingen hebben afmetingen", "Alle afbeeldingen hebben width en height.");
    }
  }

  // HTTPS.
  if (isHttps) add("good", "HTTPS actief", "De pagina is via HTTPS geladen.", 3);
  else add("high", "Website gebruikt geen HTTPS", "De pagina is via HTTP geladen.", 3);

  // Mixed content: onveilige onderdelen op een HTTPS-pagina.
  if (isHttps) {
    if (facts.insecureResources > 0) {
      add("high", "Mixed content gevonden", `${facts.insecureResources} onderdelen laden via onveilig HTTP.`, 2);
    } else {
      add("good", "Geen mixed content", "Alle onderdelen laden via HTTPS.", 2);
    }
  }

  // Zoekmachines mogen de pagina niet worden geblokkeerd
  if (/noindex/.test(facts.robots)) add("high", "Pagina staat op noindex", "Zoekmachines worden gevraagd deze pagina niet te tonen.", 3);
  else add("good", "Pagina mag worden geïndexeerd", "Er is geen noindex gevonden.", 2);

  // Doctype en tekenset
  if (facts.hasDoctype) add("good", "Doctype aanwezig", "De pagina begint met <!doctype html>.");
  else add("medium", "Doctype ontbreekt", "De pagina begint niet met <!doctype html>.");
  if (facts.hasMetaCharset || headerCharset) add("good", "Tekenset ingesteld", "De tekenset is bekend.");
  else add("medium", "Tekenset ontbreekt", "Er is geen charset gevonden.");

  // Taal van de pagina.
  if (facts.lang) add("good", "Taal van de pagina ingesteld", `lang="${facts.lang}"`);
  else add("medium", "Taalattribuut ontbreekt", "De html-tag heeft geen lang-attribuut.");

  // Viewport voor mobiel gebruik.
  if (facts.hasViewport) add("good", "Viewport-tag gevonden", "De pagina is voorbereid op mobiele apparaten.", 2);
  else add("medium", "Viewport-tag ontbreekt", "Er is geen viewport meta-tag gevonden.", 2);

  // Canonical-link.
  if (facts.hasCanonical) add("good", "Canonical-link gevonden", "De voorkeurs-URL van de pagina is ingesteld.");
  else add("low", "Canonical-link ontbreekt", "Er is geen canonical-link gevonden.");

  // Open Graph en Twitter Card voor delen op social media.
  if (facts.og.title) add("good", "Open Graph-titel gevonden", "De pagina heeft een titel voor social media.");
  else add("low", "Open Graph-titel ontbreekt", "Er is geen og:title gevonden.");
  if (facts.og.description) add("good", "Open Graph-beschrijving gevonden", "De pagina heeft een beschrijving voor social media.");
  else add("low", "Open Graph-beschrijving ontbreekt", "Er is geen og:description gevonden.");
  if (facts.og.image) add("good", "Open Graph-afbeelding gevonden", "De pagina heeft een afbeelding voor social media.");
  else add("low", "Open Graph-afbeelding ontbreekt", "Er is geen og:image gevonden.");
  if (facts.hasTwitterCard) add("good", "Twitter Card gevonden", "De pagina heeft een twitter:card.");
  else add("low", "Twitter Card ontbreekt", "Er is geen twitter:card gevonden.");

  // Gestructureerde data.
  if (facts.hasJsonLd) add("good", "Gestructureerde data gevonden", "De pagina bevat JSON-LD.");
  else add("low", "Gestructureerde data ontbreekt", "Er is geen JSON-LD gevonden.");

  // Favicon, robots.txt en sitemap.xml.
  if (hasFaviconFile) add("good", "Favicon gevonden", "De website heeft een favicon.");
  else add("low", "Favicon ontbreekt", "Er is geen favicon gevonden.");
  if (hasRobots) add("good", "robots.txt gevonden", "Het bestand robots.txt is aanwezig.");
  else add("medium", "robots.txt ontbreekt", "Er is geen robots.txt gevonden.");
  if (hasSitemap) add("good", "sitemap.xml gevonden", "Het bestand sitemap.xml is aanwezig.");
  else add("medium", "sitemap.xml ontbreekt", "Er is geen sitemap.xml gevonden.");

  // Links: duidelijke teksten en veilig openen in een nieuw tabblad.
  if (facts.vagueLinks > 0) add("low", "Vage linkteksten gevonden", `${facts.vagueLinks} links zeggen niets over het doel (zoals "klik hier").`);
  else add("good", "Duidelijke linkteksten", "Er zijn geen vage linkteksten gevonden.");
  if (facts.unsafeBlank > 0) add("low", "Links openen onveilig in nieuw tabblad", `${facts.unsafeBlank} links met target="_blank" hebben geen rel="noopener".`);
  else add("good", "Links openen veilig", "Geen onveilige target=\"_blank\" links gevonden.");

  // Genoeg tekst op de pagina.
  if (facts.wordCount < 300) add("low", "Weinig tekst op de pagina", `Er zijn ongeveer ${facts.wordCount} woorden gevonden (minimaal 300 aanbevolen).`);
  else add("good", "Voldoende tekst op de pagina", `Er zijn ongeveer ${facts.wordCount} woorden gevonden.`);

  // Scripts die het laden van de pagina blokkeren.
  if (facts.blockingScripts > 0) add("medium", "Scripts blokkeren het laden", `${facts.blockingScripts} scripts in de head hebben geen async of defer.`, 2);
  else add("good", "Geen blokkerende scripts", "Scripts in de head laden zonder te blokkeren.", 2);

  // Beveiligingsheaders in het antwoord van de server.
  const csp = headers.get("content-security-policy") || "";
  const missing = [];
  if (isHttps && !headers.get("strict-transport-security")) missing.push("Strict-Transport-Security");
  if (!csp) missing.push("Content-Security-Policy");
  if (!headers.get("x-content-type-options")) missing.push("X-Content-Type-Options");
  if (!headers.get("x-frame-options") && !/frame-ancestors/i.test(csp)) missing.push("X-Frame-Options");
  if (!headers.get("referrer-policy")) missing.push("Referrer-Policy");
  if (!headers.get("permissions-policy")) missing.push("Permissions-Policy");
  if (missing.length === 0) {
    add("good", "Beveiligingsheaders aanwezig", "Alle gecontroleerde beveiligingsheaders zijn ingesteld.", 2);
  } else {
    const level = missing.length >= 5 ? "high" : missing.length >= 3 ? "medium" : "low";
    add(level, "Beveiligingsheaders ontbreken", `Ontbreekt: ${missing.join(", ")}.`, 2);
  }

  // Server die zijn techniek verraadt.
  const powered = headers.get("x-powered-by");
  if (powered) add("low", "Serverinformatie lekt", `X-Powered-By toont: ${powered}.`);
  else add("good", "Geen serverinformatie zichtbaar", "X-Powered-By is niet ingesteld.");

  // Compressie en caching.
  const encoding = headers.get("content-encoding");
  if (encoding) add("good", "Compressie actief", `De server gebruikt ${encoding}.`, 2);
  else if (bytes > 10000) add("medium", "Compressie ontbreekt", "De pagina wordt zonder gzip of brotli verstuurd.", 2);
  else add("good", "Pagina is klein", "Compressie is hier niet nodig.");
  if (headers.get("cache-control")) add("good", "Cache-Control aanwezig", headers.get("cache-control").slice(0, 120));
  else add("low", "Cache-Control ontbreekt", "De server geeft geen cacheregels mee.");

  // Grootte van de HTML.
  const kb = Math.round(bytes / 1024);
  if (bytes > 500_000) add("high", "HTML is erg groot", `De HTML is ${kb} KB.`, 2);
  else if (bytes > 200_000) add("medium", "HTML is groot", `De HTML is ${kb} KB.`, 2);
  else add("good", "HTML heeft een goede grootte", `De HTML is ${kb} KB.`);

  // Aantal doorverwijzingen voordat de pagina laadt.
  if (redirects >= 3) add("medium", "Te veel doorverwijzingen", `Er zijn ${redirects} redirects voor de pagina laadt.`);
  else if (redirects === 2) add("low", "Meerdere doorverwijzingen", "Er zijn 2 redirects voor de pagina laadt.");
  else add("good", "Weinig doorverwijzingen", `Er zijn ${redirects} redirects.`);

  // Reactietijd van de server.
  if (ms > 3000) add("high", "Trage serverreactie", `De server reageerde na ${ms} ms.`, 2);
  else if (ms > 1500) add("medium", "Trage serverreactie", `De server reageerde na ${ms} ms.`, 2);
  else add("good", "Snelle serverreactie", `De server reageerde na ${ms} ms.`, 2);

  // Bereken een strenge, gewogen score: middelmatige punten leveren bijna niets op.
  const points = { good: 1, low: 0.25, medium: 0.05, high: 0 };
  const totalWeight = findings.reduce((sum, f) => sum + f.weight, 0);
  const earned = findings.reduce((sum, f) => sum + f.weight * points[f.level], 0);
  const criticalCount = findings.filter((f) => f.level === "high").length;
  const mediumCount = findings.filter((f) => f.level === "medium").length;
  const weightedScore = (100 * earned) / Math.max(1, totalWeight);
  // Extra aftrek voor ernstige en middelmatige problemen; nooit één vaste score-cap.
  const score = Math.max(0, Math.min(100,
    Math.round(weightedScore - criticalCount * 2 - mediumCount * 0.5)
  ));

  // Zet de slechtste punten bovenaan en de goede onderaan.
  const order = { high: 0, medium: 1, low: 2, good: 3 };
  findings.sort((a, b) => order[a.level] - order[b.level]);

  // Stuur scanresultaten als gegevens terug naar script.js.
  return {
    url: finalUrl,
    status,
    score,
    findings: findings.map(({ level, title, detail }) => ({ level, title, detail })),
    counts: { links: facts.linkCount, images: facts.images.length },
    notice: "Dit is een strenge technische scan. De tool controleert geen inhoudelijke kwaliteit, echte toegankelijkheid of kapotte links.",
  };
}

// Vraag een Lighthouse-rapport op via de Google PageSpeed Insights API.
async function analyze(url) {
  if (!process.env.PAGESPEED_API_KEY) {
    const error = new Error("De Lighthouse API-key ontbreekt. Zet PAGESPEED_API_KEY in het .env-bestand en start de server opnieuw.");
    error.statusCode = 503;
    throw error;
  }

  const safeUrl = await validatePublicUrl(url);
  const endpoint = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  endpoint.searchParams.set("url", safeUrl);
  endpoint.searchParams.set("key", process.env.PAGESPEED_API_KEY);
  endpoint.searchParams.set("strategy", "mobile");
  for (const category of ["performance", "accessibility", "best-practices", "seo"]) {
    endpoint.searchParams.append("category", category);
  }

  let response;
  try {
    response = await fetch(endpoint, { signal: AbortSignal.timeout(120000) });
  } catch {
    const error = new Error("Google Lighthouse is niet bereikbaar. Probeer het later opnieuw.");
    error.statusCode = 502;
    throw error;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error?.message || "Google kon deze website niet analyseren.";
    const error = new Error(message);
    error.statusCode = response.status === 429 ? 429 : 502;
    throw error;
  }

  const lighthouse = payload.lighthouseResult;
  if (!lighthouse?.categories) {
    const error = new Error("Google heeft geen Lighthouse-resultaten teruggegeven.");
    error.statusCode = 502;
    throw error;
  }

  const categoryNames = {
    performance: "Snelheid",
    accessibility: "Toegankelijkheid",
    "best-practices": "Veilig en goed gebouwd",
    seo: "Vindbaarheid in zoekmachines",
  };
  const categories = Object.entries(lighthouse.categories)
    .filter(([id, category]) => categoryNames[id] && Number.isFinite(category.score))
    .map(([id, category]) => ({
      id,
      title: categoryNames[id],
      score: Math.round(category.score * 100),
    }));

  const score = categories.length
    ? Math.round(categories.reduce((sum, category) => sum + category.score, 0) / categories.length)
    : 0;

  const referencedAudits = new Set();
  for (const category of Object.values(lighthouse.categories)) {
    for (const ref of category.auditRefs || []) {
      if (ref.weight > 0) referencedAudits.add(ref.id);
    }
  }

  // Vertaal bekende Lighthouse-termen naar uitleg voor niet-technische lezers.
  const plainGuides = {
    "largest-contentful-paint": {
      goodTitle: "De belangrijkste inhoud verschijnt snel",
      goodDetail: "Bezoekers zien snel het grootste en belangrijkste onderdeel van de pagina.",
      issueTitle: "De belangrijkste inhoud verschijnt langzaam",
      issueDetail: "Het grootste zichtbare onderdeel van de pagina laat bezoekers te lang wachten.",
      advice: "Laat grote afbeeldingen verkleinen en vraag de websitebouwer om de bovenkant van de pagina sneller te maken.",
    },
    "first-contentful-paint": {
      goodTitle: "De pagina wordt snel zichtbaar",
      goodDetail: "Bezoekers zien kort na het openen al iets op de pagina verschijnen.",
      issueTitle: "Het duurt even voordat de pagina zichtbaar wordt",
      issueDetail: "Bezoekers zien niet meteen dat de pagina aan het laden is.",
      advice: "Vraag de websitebouwer om onnodige onderdelen bij het openen te verminderen.",
    },
    "speed-index": {
      goodTitle: "De pagina vult zich vlot",
      goodDetail: "De inhoud wordt in een prettig tempo zichtbaar.",
      issueTitle: "De pagina vult zich langzaam",
      issueDetail: "Het duurt relatief lang voordat de zichtbare inhoud compleet is.",
      advice: "Kleinere afbeeldingen en minder onnodige onderdelen kunnen de pagina sneller laten laden.",
    },
    "total-blocking-time": {
      goodTitle: "De pagina reageert vlot",
      goodDetail: "De pagina wordt niet lang beziggehouden voordat bezoekers ermee kunnen werken.",
      issueTitle: "De pagina reageert traag op aanraken",
      issueDetail: "Na het openen kan het even duren voordat knoppen en menu's reageren.",
      advice: "Vraag de websitebouwer om onderdelen die de pagina vertragen te verminderen.",
    },
    "interaction-to-next-paint": {
      goodTitle: "De pagina reageert snel op bezoekers",
      goodDetail: "Na een tik of klik wordt de verandering snel zichtbaar.",
      issueTitle: "De pagina reageert traag op bezoekers",
      issueDetail: "Na een tik of klik duurt het te lang voordat de pagina reageert.",
      advice: "Laat de websitebouwer controleren welke onderdelen de reactie op klikken vertragen.",
    },
    "cumulative-layout-shift": {
      goodTitle: "De pagina blijft netjes op zijn plek",
      goodDetail: "Tekst en knoppen verspringen weinig tijdens het laden.",
      issueTitle: "Onderdelen verspringen tijdens het laden",
      issueDetail: "Tekst of knoppen kunnen verschuiven terwijl bezoekers de pagina bekijken.",
      advice: "Vraag de websitebouwer om afbeeldingen en andere onderdelen vooraf vaste ruimte te geven.",
    },
    "render-blocking-resources": {
      issueTitle: "De pagina wacht op onderdelen voordat ze verschijnt",
      issueDetail: "Enkele websitebestanden houden het zichtbaar worden van de pagina tegen.",
      advice: "Vraag de websitebouwer om alleen noodzakelijke onderdelen meteen te laden.",
    },
    "unused-javascript": {
      issueTitle: "Er wordt onnodige achtergrondcode geladen",
      issueDetail: "De pagina laadt code die voor deze pagina niet nodig lijkt.",
      advice: "Laat de websitebouwer overbodige onderdelen weghalen of pas laden wanneer ze nodig zijn.",
    },
    "unused-css-rules": {
      issueTitle: "Er worden onnodige vormgevingsbestanden geladen",
      issueDetail: "De pagina laadt vormgevingsregels die hier niet nodig lijken.",
      advice: "Vraag de websitebouwer om ongebruikte vormgeving op te ruimen.",
    },
    "uses-optimized-images": {
      issueTitle: "Afbeeldingen kunnen kleiner worden gemaakt",
      issueDetail: "Grote afbeeldingsbestanden kunnen de pagina langzamer maken.",
      advice: "Gebruik kleinere afbeeldingsbestanden zonder zichtbaar kwaliteitsverlies.",
    },
    "modern-image-formats": {
      issueTitle: "Afbeeldingen kunnen slimmer worden opgeslagen",
      issueDetail: "Sommige afbeeldingen kunnen in een kleiner bestandsformaat worden aangeboden.",
      advice: "Vraag de websitebouwer om moderne, kleinere afbeeldingsformaten te gebruiken.",
    },
    "offscreen-images": {
      issueTitle: "Afbeeldingen onderaan laden te vroeg",
      issueDetail: "Afbeeldingen die nog niet in beeld zijn, worden mogelijk al geladen.",
      advice: "Laat afbeeldingen pas laden wanneer bezoekers er bijna naartoe scrollen.",
    },
    "uses-responsive-images": {
      issueTitle: "Afbeeldingen passen niet overal goed bij het scherm",
      issueDetail: "Telefoons laden mogelijk grotere afbeeldingen dan nodig.",
      advice: "Laat voor kleine schermen kleinere versies van afbeeldingen gebruiken.",
    },
    "uses-text-compression": {
      issueTitle: "Websitebestanden worden niet compact verstuurd",
      issueDetail: "Tekstbestanden kunnen kleiner worden verstuurd, zodat ze sneller aankomen.",
      advice: "Vraag je hostingprovider of websitebouwer om bestandscompressie in te schakelen.",
    },
    "uses-long-cache-ttl": {
      issueTitle: "Terugkerende bezoekers moeten bestanden opnieuw laden",
      issueDetail: "De browser bewaart onderdelen van de website mogelijk niet lang genoeg.",
      advice: "Vraag de websitebouwer om vaste websitebestanden langer te laten bewaren in de browser.",
    },
    "font-display": {
      issueTitle: "Tekst kan wachten op het lettertype",
      issueDetail: "Bezoekers zien mogelijk pas tekst wanneer het lettertype is geladen.",
      advice: "Laat de websitebouwer instellen dat tekst meteen zichtbaar is met een tijdelijk lettertype.",
    },
    "server-response-time": {
      issueTitle: "De website reageert langzaam",
      issueDetail: "Het duurt lang voordat de server begint met het versturen van de pagina.",
      advice: "Vraag je hostingprovider of websitebouwer om de server sneller te laten reageren.",
    },
    "image-alt": {
      goodTitle: "Afbeeldingen hebben uitleg voor schermlezers",
      goodDetail: "Mensen die een schermlezer gebruiken krijgen bij afbeeldingen een tekstuele uitleg.",
      issueTitle: "Sommige afbeeldingen missen een uitleg",
      issueDetail: "Een schermlezer kan daardoor niet vertellen wat die afbeeldingen laten zien.",
      advice: "Vraag de websitebouwer om bij betekenisvolle afbeeldingen een korte beschrijving toe te voegen.",
    },
    "color-contrast": {
      goodTitle: "Tekst is goed te onderscheiden",
      goodDetail: "De kleuren maken tekst voor de meeste bezoekers goed leesbaar.",
      issueTitle: "Sommige tekst is lastig te lezen",
      issueDetail: "Tekst en achtergrond lijken op elkaar qua kleur.",
      advice: "Kies een duidelijker verschil tussen de tekstkleur en de achtergrondkleur.",
    },
    "heading-order": {
      goodTitle: "Koppen staan in een logische volgorde",
      goodDetail: "De koppen helpen bezoekers en schermlezers de pagina te begrijpen.",
      issueTitle: "De koppen slaan stappen over",
      issueDetail: "De volgorde van grote en kleine koppen is niet overal logisch.",
      advice: "Zet koppen in volgorde: begin met de hoofdkop en gebruik daarna steeds kleinere tussenkoppen.",
    },
    "html-has-lang": {
      goodTitle: "De taal van de website is ingesteld",
      goodDetail: "Hulpmiddelen kunnen herkennen in welke taal de pagina is geschreven.",
      issueTitle: "De website vermeldt de taal niet",
      issueDetail: "Een schermlezer weet daardoor mogelijk niet hoe de tekst moet worden uitgesproken.",
      advice: "Vraag de websitebouwer om de juiste taal van de pagina in te stellen.",
    },
    "button-name": {
      goodTitle: "Knoppen hebben een duidelijke naam",
      goodDetail: "Hulpmiddelen kunnen vertellen wat de knoppen doen.",
      issueTitle: "Sommige knoppen zijn niet duidelijk benoemd",
      issueDetail: "Een schermlezer kan mogelijk niet vertellen waarvoor een knop dient.",
      advice: "Geef elke knop een korte naam die uitlegt wat er gebeurt als je erop drukt.",
    },
    "link-name": {
      goodTitle: "Links maken duidelijk waar ze naartoe gaan",
      goodDetail: "Bezoekers kunnen aan de linktekst zien wat ze kunnen verwachten.",
      issueTitle: "Sommige links zijn niet duidelijk benoemd",
      issueDetail: "Bezoekers die een schermlezer gebruiken weten mogelijk niet waar een link naartoe gaat.",
      advice: "Gebruik linkteksten die het doel noemen, zoals ‘Bekijk onze contactgegevens’.",
    },
    "label": {
      goodTitle: "Invulvelden hebben duidelijke uitleg",
      goodDetail: "Bezoekers kunnen zien wat ze in de invulvelden moeten invullen.",
      issueTitle: "Sommige invulvelden missen uitleg",
      issueDetail: "Bezoekers weten mogelijk niet welke informatie in een invulveld hoort.",
      advice: "Zet bij elk invulveld een duidelijk zichtbaar label met de gevraagde informatie.",
    },
    "document-title": {
      goodTitle: "De pagina heeft een herkenbare titel",
      goodDetail: "De paginatitel helpt bezoekers het tabblad en de pagina te herkennen.",
      issueTitle: "De pagina mist een herkenbare titel",
      issueDetail: "Het browsertabblad vertelt niet duidelijk welke pagina openstaat.",
      advice: "Geef de pagina een korte titel die vertelt waar de pagina over gaat.",
    },
    "meta-description": {
      goodTitle: "Zoekresultaten kunnen een duidelijke samenvatting tonen",
      goodDetail: "De pagina heeft een samenvatting die zoekmachines kunnen laten zien.",
      issueTitle: "De pagina mist een samenvatting voor zoekresultaten",
      issueDetail: "Zoekmachines hebben geen duidelijke korte uitleg over de pagina gekregen.",
      advice: "Schrijf een korte, duidelijke samenvatting van de pagina voor zoekresultaten.",
    },
    "is-on-https": {
      goodTitle: "De website gebruikt een beveiligde verbinding",
      goodDetail: "Gegevens tussen de bezoeker en de website worden via een beveiligde verbinding verstuurd.",
      issueTitle: "De website gebruikt geen beveiligde verbinding",
      issueDetail: "De verbinding met de website is niet goed beveiligd.",
      advice: "Vraag je hostingprovider om HTTPS in te stellen voor de website.",
    },
    "is-crawlable": {
      goodTitle: "Zoekmachines kunnen de pagina bekijken",
      goodDetail: "De pagina lijkt niet geblokkeerd voor zoekmachines.",
      issueTitle: "Zoekmachines kunnen de pagina mogelijk niet vinden",
      issueDetail: "Een instelling kan zoekmachines tegenhouden om de pagina op te nemen.",
      advice: "Vraag de websitebeheerder of deze pagina zichtbaar hoort te zijn in Google en laat de blokkade controleren.",
    },
    "robots-txt": {
      goodTitle: "De website heeft zoekmachine-instructies",
      goodDetail: "Er is een bestand gevonden dat zoekmachines aanwijzingen kan geven.",
      issueTitle: "Zoekmachine-instructies ontbreken of zijn niet goed ingesteld",
      issueDetail: "Zoekmachines missen mogelijk aanwijzingen over welke pagina's ze mogen bekijken.",
      advice: "Vraag de websitebeheerder om het zoekmachinebestand te controleren.",
    },
    canonical: {
      goodTitle: "Zoekmachines krijgen de voorkeursversie van de pagina door",
      goodDetail: "De website geeft aan welk adres als hoofdversie moet worden gebruikt.",
      issueTitle: "De voorkeursversie van de pagina is niet ingesteld",
      issueDetail: "Zoekmachines kunnen twijfelen welk adres de officiële versie is.",
      advice: "Vraag de websitebouwer om het vaste voorkeursadres van de pagina in te stellen.",
    },
  };

  const explainAudit = (id, audit, passed) => {
    const guide = plainGuides[id];
    if (guide) {
      return {
        title: passed ? (guide.goodTitle || "Dit onderdeel werkt goed") : (guide.issueTitle || "Dit onderdeel kan beter"),
        detail: passed ? (guide.goodDetail || "Deze controle is goed uitgevoerd.") : (guide.issueDetail || "Lighthouse heeft hier een aandachtspunt gevonden."),
        advice: passed ? "" : guide.advice,
      };
    }
    if (passed) {
      return {
        title: "Dit onderdeel werkt goed",
        detail: "Lighthouse heeft deze controle goed beoordeeld. Dat helpt de website prettig en betrouwbaar te gebruiken.",
        advice: "",
      };
    }
    return {
      title: "Dit onderdeel kan beter",
      detail: "Lighthouse heeft hier een aandachtspunt gevonden dat de ervaring van bezoekers kan verbeteren.",
      advice: "Deel dit rapport met je websitebeheerder of webbouwer en vraag om uitleg en een praktische oplossing.",
    };
  };

  const auditResults = [...referencedAudits]
    .map((id) => ({ id, audit: lighthouse.audits?.[id] }))
    .filter(({ audit }) => audit && Number.isFinite(audit.score));

  const findings = auditResults
    .filter(({ audit }) => audit.score < 0.9)
    .sort((a, b) => a.audit.score - b.audit.score)
    .slice(0, 15)
    .map(({ id, audit }) => ({
      id,
      level: audit.score === 0 ? "high" : audit.score < 0.5 ? "medium" : "low",
      ...explainAudit(id, audit, false),
    }));

  const strengths = auditResults
    .filter(({ audit }) => audit.score >= 0.9)
    .sort((a, b) => b.audit.score - a.audit.score)
    .slice(0, 15)
    .map(({ id, audit }) => ({
      id,
      ...explainAudit(id, audit, true),
    }));

  return {
    url: lighthouse.finalDisplayedUrl || payload.id || safeUrl,
    strategy: "mobile",
    score,
    categories,
    strengths,
    findings,
    lighthouseVersion: lighthouse.lighthouseVersion || "",
    fetchedAt: new Date().toISOString(),
    notice: "Dit rapport is een momentopname van een mobiele test. Scores kunnen per test iets verschillen. Je hoeft zelf geen code aan te passen: bespreek verbeterpunten met je websitebouwer.",
  };
}

// Verstuur een JSON-resultaat naar de browser.
function sendJson(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

// Maak een PDF met het aangeleverde Lighthouse-resultaat en het Digiwerkplaats-logo.
function sendReportPdf(res, report) {
  const clean = (value, max = 1200) => String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  const categories = Array.isArray(report.categories) ? report.categories.slice(0, 4) : [];
  const strengths = Array.isArray(report.strengths) ? report.strengths.slice(0, 15) : [];
  const findings = Array.isArray(report.findings) ? report.findings.slice(0, 15) : [];
  const score = Math.max(0, Math.min(100, Math.round(Number(report.score) || 0)));
  const date = new Date().toLocaleDateString("nl-NL");
  const filenameDate = new Date().toISOString().slice(0, 10);

  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="lighthouse-rapport-${filenameDate}.pdf"`,
    "Cache-Control": "no-store",
  });

  const doc = new PDFDocument({ size: "A4", margin: 48 });
  doc.pipe(res);

  const logoPath = path.join(__dirname, "logo.jpg");
  if (fs.existsSync(logoPath)) doc.image(logoPath, 48, 38, { fit: [190, 76] });
  doc.fillColor("#20205e").font("Helvetica-Bold").fontSize(24).text("Websitecheck-resultaat", 48, 128);
  doc.fillColor("#59657a").font("Helvetica").fontSize(10).text(`Gegenereerd op ${date}`, 48, 160);
  doc.moveDown(1.2);
  doc.fillColor("#27334a").font("Helvetica").fontSize(10)
    .text("In dit rapport lees je wat al goed gaat en wat je kunt verbeteren. Je hoeft zelf geen code aan te passen: bespreek de praktische tips met je websitebeheerder of webbouwer.", { width: 499, lineGap: 3 });
  doc.moveDown(0.9);
  doc.fillColor("#18233b").font("Helvetica-Bold").fontSize(12).text("Websiteadres");
  doc.fillColor("#315fdb").font("Helvetica").fontSize(10).text(clean(report.url, 500));

  const scoreY = doc.y + 18;
  doc.roundedRect(48, scoreY, 499, 84, 12).fill("#f0f3ff");
  doc.fillColor("#20205e").font("Helvetica-Bold").fontSize(12).text("Gemiddelde website-score", 66, scoreY + 16);
  doc.fillColor("#5c4ce1").fontSize(30).text(`${score}/100`, 66, scoreY + 36);
  doc.y = scoreY + 102;

  doc.fillColor("#59657a").font("Helvetica").fontSize(9)
    .text("De totaalscore is het gemiddelde van vier onderdelen. Een hogere score is beter.", { width: 499 });
  doc.moveDown(0.8);
  doc.fillColor("#18233b").font("Helvetica-Bold").fontSize(15).text("Scores per onderdeel");
  doc.moveDown(0.5);
  const categoryDescriptions = {
    performance: "Hoe snel de pagina zichtbaar wordt en reageert.",
    accessibility: "Hoe makkelijk de website te gebruiken is, ook met hulpmiddelen.",
    "best-practices": "Of de website op belangrijke technische punten goed en veilig is ingericht.",
    seo: "Hoe goed zoekmachines de pagina kunnen begrijpen en tonen.",
  };
  for (const category of categories) {
    const categoryScore = Math.max(0, Math.min(100, Math.round(Number(category.score) || 0)));
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#27334a").text(clean(category.title, 100), { continued: true });
    doc.font("Helvetica").fillColor("#5c4ce1").text(`     ${categoryScore}/100`);
    doc.font("Helvetica").fontSize(8).fillColor("#59657a")
      .text(categoryDescriptions[category.id] || "Een controle van een belangrijk onderdeel van de website.");
    doc.moveDown(0.45);
  }

  doc.moveDown(0.7);
  doc.fillColor("#18233b").font("Helvetica-Bold").fontSize(15).text("Wat gaat al goed");
  doc.moveDown(0.5);
  if (!strengths.length) {
    doc.font("Helvetica").fontSize(10).fillColor("#59657a").text("Er zijn geen positieve controles opgenomen in dit rapport.");
  }
  for (const strength of strengths) {
    if (doc.y > 700) doc.addPage();
    doc.fillColor("#12804b").font("Helvetica-Bold").fontSize(10).text(clean(strength.title, 180));
    if (strength.detail) doc.fillColor("#59657a").font("Helvetica").fontSize(9).text(clean(strength.detail));
    doc.moveDown(0.65);
  }

  doc.moveDown(0.7);
  doc.fillColor("#18233b").font("Helvetica-Bold").fontSize(15).text("Wat kan beter");
  doc.moveDown(0.5);
  if (!findings.length) {
    doc.font("Helvetica").fontSize(10).fillColor("#59657a").text("Er zijn geen verbeterpunten opgenomen in dit rapport.");
  }
  for (const finding of findings) {
    if (doc.y > 700) doc.addPage();
    const level = ["high", "medium", "low"].includes(finding.level) ? finding.level : "low";
    const color = level === "high" ? "#bd3838" : level === "medium" ? "#a36b00" : "#315fdb";
    doc.fillColor(color).font("Helvetica-Bold").fontSize(10).text(clean(finding.title, 180));
    if (finding.detail) doc.fillColor("#59657a").font("Helvetica").fontSize(9).text(clean(finding.detail));
    if (finding.advice) {
      doc.moveDown(0.2);
      doc.fillColor("#27334a").font("Helvetica").fontSize(9).text(`Advies: ${clean(finding.advice)}`);
    }
    doc.moveDown(0.65);
  }

  doc.moveDown(0.5);
  doc.fillColor("#778198").font("Helvetica").fontSize(8)
    .text(clean(report.notice || "Scores zijn afkomstig van Google Lighthouse."), { lineGap: 2 });
  doc.end();
}

// Maak de server: bestanden serveren (GET) en analyse starten (POST).
const server = http.createServer(async (req, res) => {
  // GET: serveer bestanden uit de hoofdmap en afbeeldingen uit img/.
  if (req.method === "GET") {
    let pathname = decodeURIComponent(req.url.split("?")[0]);
    if (pathname === "/") pathname = "/index.html";

    const segments = pathname.split("/").filter(Boolean);
    const name = path.basename(pathname);
    const type = name === "script.js" ? "application/javascript; charset=utf-8" : TYPES[path.extname(name).toLowerCase()];
    const isRootFile = segments.length === 1 && pathname === "/" + name;
    const isImageFile = segments.length === 2 && segments[0] === "img"
      && pathname === "/img/" + name && type && type.startsWith("image/");
    if (!type || (!isRootFile && !isImageFile)) {
      res.writeHead(404);
      res.end("Niet gevonden: " + pathname);
      return;
    }

    fs.readFile(path.join(__dirname, ...segments), (error, payload) => {
      if (error) {
        res.writeHead(404);
        res.end(`${pathname} staat niet op de server`);
        return;
      }
      res.writeHead(200, { "Content-Type": type, "Content-Length": payload.length });
      res.end(payload);
    });
    return;
  }

  // POST: maak een downloadbare PDF van de resultaten.
  if (req.method === "POST" && req.url === "/api/report.pdf") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 100_000) {
        sendJson(res, 413, { error: "Het rapport is te groot om als PDF te maken." });
        return;
      }
    }
    try {
      const report = JSON.parse(body);
      if (!report || !Array.isArray(report.categories) || !Number.isFinite(Number(report.score))) {
        sendJson(res, 400, { error: "De scanresultaten zijn ongeldig." });
        return;
      }
      sendReportPdf(res, report);
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: "De PDF kon niet worden gemaakt." });
      else res.destroy(error);
    }
    return;
  }

  // POST: ontvang de URL uit script.js en start de Lighthouse-analyse.
  if (req.method === "POST" && req.url === "/api/analyze") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 5000) {
        sendJson(res, 413, { error: "De invoer is te groot" });
        return;
      }
    }
    try {
      const data = JSON.parse(body);
      const result = await analyze(String(data.url || "").trim());
      sendJson(res, 200, result);
    } catch (error) {
      const status = error.statusCode || 400;
      sendJson(res, status, { error: error.message || "De scan is mislukt." });
    }
    return;
  }

  res.writeHead(404);
  res.end("Niet gevonden");
});

// Start de server; Ctrl+C stopt hem weer.
server.on("error", (error) => {
  console.log(`De server kon niet starten op poort ${PORT}: ${error.message}`);
  console.log("Sluit een andere app op die poort of verander PORT bovenaan server.js.");
});
server.listen(PORT, HOST, () => {
  console.log(`SiteScan draait op http://${HOST}:${PORT}`);
});
