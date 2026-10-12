# SiteScan — Lighthouse

SiteScan gebruikt de Google PageSpeed Insights API om een Lighthouse-scan uit te voeren op mobiel. Het rapport bevat scores voor prestaties, toegankelijkheid, best practices en SEO. Na elke scan kun je een PDF-rapport met het Digiwerkplaats Rijnmond-logo downloaden.

## Eenmalig instellen

1. Installeer Node.js (versie 18 of hoger).
2. Maak in Google Cloud een API-key aan en schakel de **PageSpeed Insights API** in voor het project. Beperk de key waar mogelijk tot deze API.
3. Kopieer `.env.example` naar een nieuw bestand met de naam `.env`.
4. Open `.env` en vervang `plak_hier_je_google_api_key` door je API-key. Deel dit bestand of de key niet openbaar.
5. Installeer de pakketten in deze map met `npm install`.

## Starten

Dubbelklik op `start-windows.bat`, of start de server met `node server.js` vanuit deze map. Open daarna <http://127.0.0.1:8000>. Laat het terminalvenster open zolang je de website gebruikt.

De API-key wordt alleen door `server.js` gebruikt en komt niet in de browsercode terecht. Lighthouse gebruikt een mobiele laboratoriummeting; scores kunnen per scan verschillen. De gemiddelde score op de website en in de PDF is het gemiddelde van de vier Lighthouse-categorieën.
