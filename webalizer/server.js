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

// Alleen deze bestanden mogen worden opgevraagd.
const FILES = {
  "/index.html": "text/html; charset=utf-8",
  "/style.css": "text/css; charset=utf-8",
  "/script.js": "application/javascript; charset=utf-8",
  "/img/logo2.jpg": "image/jpg",
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

// Haal de pagina op en controleer ook elke doorverwijzing (redirect).
async function fetchPage(startUrl) {
  let current = await validatePublicUrl(startUrl);

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const response = await fetch(current, {
      redirect: "manual",
      headers: { "User-Agent": "SiteScan/1.0" },
      signal: AbortSignal.timeout(12000),
    });

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
    return { html, status: response.status, finalUrl: current };
  }
  throw new Error("Te veel doorverwijzingen");
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

// Lees de feiten uit de HTML: titel, description, H1, afbeeldingen en links.
function readFacts(html) {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";

  let description = "";
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = parseAttributes(tag);
    if ((attrs.name || "").toLowerCase() === "description") {
      description = attrs.content || "";
    }
  }

  const h1Count = (html.match(/<h1[\s>]/gi) || []).length;
  const images = (html.match(/<img\b[^>]*>/gi) || []).map((tag) => parseAttributes(tag).alt || "");
  const links = (html.match(/<a\b[^>]*>/gi) || []).filter((tag) => parseAttributes(tag).href);

  return { title, description, h1Count, images, linkCount: links.length };
}

// Voer alle controles uit en maak het rapport.
async function analyze(url) {
  const { html, status, finalUrl } = await fetchPage(url);
  const facts = readFacts(html);
  const findings = [];

  // Sla één controle op voor het rapport in de browser.
  const add = (level, title, detail) => findings.push({ level, title, detail });

  // Controleer of de pagina een titel heeft.
  if (facts.title) add("good", "Paginatitel gevonden", facts.title.slice(0, 180));
  else add("high", "Paginatitel ontbreekt", "Er is geen paginatitel gevonden.");

  // Controleer de meta description.
  if (facts.description) add("good", "Meta description gevonden", facts.description.slice(0, 240));
  else add("medium", "Meta description ontbreekt", "Er is geen meta description gevonden.");

  // Controleer het aantal hoofdkoppen.
  if (facts.h1Count === 0) add("medium", "Geen H1-kop gevonden", "Er is geen H1-hoofdkop gevonden.");
  else if (facts.h1Count > 1) add("low", "Meerdere H1-koppen gevonden", `Er zijn ${facts.h1Count} H1-koppen gevonden.`);
  else add("good", "Eén H1-kop gevonden", "Er is één H1-hoofdkop gevonden.");

  // Controleer of afbeeldingen een alt-attribuut hebben.
  const missingAlt = facts.images.filter((alt) => !alt).length;
  if (facts.images.length === 0) {
    add("good", "Geen afbeeldingen gevonden", "Er zijn geen img-elementen gevonden.");
  } else if (missingAlt) {
    add("medium", "Afbeeldingen zonder alt-tekst", `${missingAlt} van de ${facts.images.length} afbeeldingen hebben geen alt-tekst.`);
  } else {
    add("good", "Alt-attributen gevonden", `Alle ${facts.images.length} afbeeldingen hebben een alt-attribuut.`);
  }

  // Controleer of de website via HTTPS is geladen.
  if (new URL(finalUrl).protocol === "https:") add("good", "HTTPS actief", "De pagina is via HTTPS geladen.");
  else add("high", "Website gebruikt geen HTTPS", "De pagina is via HTTP geladen.");

  // Bereken het percentage controles met een goede uitkomst.
  const goodCount = findings.filter((f) => f.level === "good").length;
  const score = Math.round((100 * goodCount) / Math.max(1, findings.length));

  // Stuur scanresultaten als gegevens terug naar script.js.
  return {
    url: finalUrl,
    status,
    score,
    findings,
    counts: { links: facts.linkCount, images: facts.images.length },
    notice: "Dit is een beperkte technische scan. De tool controleert geen inhoudelijke kwaliteit, echte toegankelijkheid of kapotte links.",
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
  // GET: serveer index.html, style.css, script.js en logo.jpg.
  if (req.method === "GET") {
    const pathname = req.url.split("?")[0];
    const file = pathname === "/" ? "/index.html" : pathname;
    if (!FILES[file]) {
      res.writeHead(404);
      res.end("Niet gevonden");
      return;
    }
    fs.readFile(path.join(__dirname, file), (error, payload) => {
      if (error) {
        res.writeHead(500);
        res.end(`${file} niet gevonden naast server.js`);
        return;
      }
      res.writeHead(200, { "Content-Type": FILES[file], "Content-Length": payload.length });
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