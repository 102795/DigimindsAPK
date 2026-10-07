// Importeer de ingebouwde Node-onderdelen (geen extra pakketten nodig).
const http = require("http");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");

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
async function analyze(url) {
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

  // Meta description: aanwezig en tussen 70 en 160 tekens.
  const descLength = facts.description.length;
  if (!descLength) {
    add("medium", "Meta description ontbreekt", "Er is geen meta description gevonden.", 2);
  } else if (descLength < 70 || descLength > 160) {
    add("low", "Meta description heeft een slechte lengte", `${descLength} tekens (ideaal: 70 tot 160).`, 2);
  } else {
    add("good", "Meta description gevonden", facts.description, 2);
  }

  // Hoofdkoppen: precies één H1.
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

  // Zoekmachines mogen de pagina niet worden geblokkeerd.
  if (/noindex/.test(facts.robots)) add("high", "Pagina staat op noindex", "Zoekmachines worden gevraagd deze pagina niet te tonen.", 3);
  else add("good", "Pagina mag worden geïndexeerd", "Er is geen noindex gevonden.", 2);

  // Doctype en tekenset.
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

  // Strenge score: good = 100%, low = 50%, medium en high = 0%, gewogen per controle.
  const points = { good: 1, low: 0.5, medium: 0, high: 0 };
  const totalWeight = findings.reduce((sum, f) => sum + f.weight, 0);
  const earned = findings.reduce((sum, f) => sum + f.weight * points[f.level], 0);
  let score = Math.round((100 * earned) / Math.max(1, totalWeight));

  // Met een rood punt kom je nooit boven de 60.
  if (findings.some((f) => f.level === "high")) score = Math.min(score, 60);

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

// Verstuur een JSON-resultaat naar de browser.
function sendJson(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
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

  // POST: ontvang de URL uit script.js en start de analyse.
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
      const isInputError = !error.name || error.name === "Error";
      sendJson(res, isInputError ? 400 : 502, {
        error: isInputError ? error.message : `De scan is mislukt: ${error.message}`,
      });
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