/* Outils communs aux tests de l'appli (aucune donnée réelle, aucun appel réseau réel).
   - servir()      : sert index.html sur 127.0.0.1 (contexte sûr pour le micro)
   - fauxGitHub()  : simule l'API Contents de GitHub en mémoire via context.route
   - lancer()      : Chromium avec micro factice accepté d'office */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright");

const RACINE = path.join(__dirname, "..");
const PROPRIO = "proprio-test", DEPOT = "bambara-fr";
const CFG = { token: "jeton-factice", owner: PROPRIO, repo: DEPOT };

function servir() {
  return new Promise((ok) => {
    const srv = http.createServer((req, res) => {
      const html = fs.readFileSync(path.join(RACINE, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
    });
    srv.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${srv.address().port}/`, fermer: () => srv.close() }));
  });
}

function lancer() {
  return chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "Authorization, Accept, X-GitHub-Api-Version, Content-Type",
};
const sha1 = (b) => crypto.createHash("sha1").update(b).digest("hex");

/* fichiers : Map chemin -> Buffer (dépôt principal seulement). panne(req) peut renvoyer :
   undefined (normal), un code HTTP, { status, headers } (ex. quota), "couper" (erreur réseau),
   "stocker-puis-couper". retard(req) : millisecondes d'attente avant la réponse.
   prives : dépôt -> private (GET /repos/{owner}/{dépôt}) ; un autre dépôt n'a aucun fichier (404).
   arbreTronque : l'arbre git répond truncated:true (l'appli revient à l'ancienne lecture). */
const shaDossier = (p) => sha1("dir:" + p);
async function fauxGitHub(context, fichiersDepart) {
  const etat = { fichiers: new Map(), requetes: [], panne: null, retard: null, prives: { [DEPOT]: true, "bambara-app": false }, arbreTronque: false };
  for (const [p, v] of Object.entries(fichiersDepart || {})) etat.fichiers.set(p, Buffer.isBuffer(v) ? v : Buffer.from(typeof v === "string" ? v : JSON.stringify(v)));
  const json = (route, status, corps) => route.fulfill({ status, headers: Object.assign({ "content-type": "application/json" }, CORS), body: JSON.stringify(corps) });

  await context.route("https://api.github.com/**", async (route) => {
    const req = route.request(), url = new URL(req.url()), methode = req.method();
    if (methode === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const base = `/repos/${PROPRIO}/${DEPOT}`;
    const dm = /^\/repos\/[^/]+\/([^/]+)/.exec(url.pathname), depot = dm ? dm[1] : null;
    const m = url.pathname.startsWith(base + "/contents/") ? decodeURIComponent(url.pathname.slice((base + "/contents/").length)) : null;
    const arbre = url.pathname.startsWith(base + "/git/trees/") ? url.pathname.slice((base + "/git/trees/").length) : null;
    let corps = null;
    if (methode === "PUT" || methode === "DELETE") { try { corps = JSON.parse(req.postData() || "{}"); } catch (e) { corps = {}; } }
    const entree = { methode, chemin: m, arbre, depot, url: url.pathname + url.search, accept: req.headers()["accept"] || "", corps };
    etat.requetes.push(entree);
    const ms = etat.retard && etat.retard(entree);
    if (ms) await new Promise((r) => setTimeout(r, ms));
    const panne = etat.panne && etat.panne(entree);
    if (panne === "couper") return route.abort("failed");
    if (typeof panne === "number") return json(route, panne, { message: "panne simulée" });
    if (panne && typeof panne === "object") return route.fulfill({ status: panne.status, headers: Object.assign({ "content-type": "application/json" }, CORS, { "access-control-expose-headers": Object.keys(panne.headers || {}).join(", ") }, panne.headers), body: JSON.stringify({ message: "panne simulée" }) });

    if (dm && url.pathname === `/repos/${PROPRIO}/${depot}` && methode === "GET") {
      if (!(depot in etat.prives)) return json(route, 404, { message: "Not Found" });
      return json(route, 200, { full_name: `${PROPRIO}/${depot}`, private: etat.prives[depot] });
    }
    if (arbre !== null && methode === "GET") {
      let dossier = null;
      for (const p of etat.fichiers.keys()) {
        const parts = p.split("/");
        for (let i = 1; i < parts.length; i++) { const d = parts.slice(0, i).join("/"); if (shaDossier(d) === arbre) dossier = d; }
      }
      if (dossier === null) return json(route, 404, { message: "Not Found" });
      const tree = [], vus = new Set();
      for (const [p, b] of etat.fichiers) {
        if (!p.startsWith(dossier + "/")) continue;
        const rel = p.slice(dossier.length + 1), parts = rel.split("/");
        for (let i = 1; i < parts.length; i++) {
          const d = parts.slice(0, i).join("/");
          if (!vus.has(d)) { vus.add(d); tree.push({ path: d, type: "tree", mode: "040000", sha: shaDossier(dossier + "/" + d) }); }
        }
        tree.push({ path: rel, type: "blob", mode: "100644", sha: sha1(b), size: b.length });
      }
      return json(route, 200, { sha: arbre, truncated: etat.arbreTronque, tree: etat.arbreTronque ? tree.slice(0, 3) : tree });
    }
    if (m === null) return json(route, 404, { message: "Not Found" });

    if (methode === "GET") {
      if (etat.fichiers.has(m)) {
        const b = etat.fichiers.get(m);
        if (entree.accept.includes("raw")) return route.fulfill({ status: 200, headers: Object.assign({ "content-type": "application/octet-stream" }, CORS), body: b });
        return json(route, 200, { type: "file", name: path.posix.basename(m), path: m, sha: sha1(b), size: b.length, content: b.toString("base64"), encoding: "base64" });
      }
      const prefixe = m ? m.replace(/\/$/, "") + "/" : "";
      const enfants = new Map();
      for (const p of etat.fichiers.keys()) {
        if (!p.startsWith(prefixe)) continue;
        const reste = p.slice(prefixe.length), nom = reste.split("/")[0];
        enfants.set(nom, reste.includes("/") ? "dir" : "file");
      }
      if (!enfants.size) return json(route, 404, { message: "Not Found" });
      return json(route, 200, [...enfants].map(([name, type]) => ({ name, type, path: prefixe + name,
        sha: type === "dir" ? shaDossier(prefixe + name) : sha1(etat.fichiers.get(prefixe + name)) })));
    }
    if (methode === "PUT") {
      const existe = etat.fichiers.get(m);
      if (existe && !corps.sha) return json(route, 422, { message: "Invalid request.\n\n\"sha\" wasn't supplied." });
      if (existe && corps.sha !== sha1(existe)) return json(route, 409, { message: "conflit" });
      const b = Buffer.from(corps.content || "", "base64");
      etat.fichiers.set(m, b);
      if (panne === "stocker-puis-couper") return route.abort("failed");
      return json(route, existe ? 200 : 201, { content: { name: path.posix.basename(m), path: m, sha: sha1(b) }, commit: { sha: sha1(m + Date.now()) } });
    }
    if (methode === "DELETE") { etat.fichiers.delete(m); return json(route, 200, { commit: {} }); }
    return json(route, 405, { message: "non géré" });
  });
  etat.puts = () => etat.requetes.filter((r) => r.methode === "PUT");
  etat.texte = (p) => etat.fichiers.has(p) ? etat.fichiers.get(p).toString("utf8") : null;
  return etat;
}

/* Petit WAV (sinus) pour les essais de fichier et d'écoute. */
function wav(secondes = 1, frequence = 440, taux = 8000) {
  const n = Math.round(secondes * taux), donnees = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) donnees.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequence * i) / taux) * 12000), i * 2);
  const t = Buffer.alloc(44);
  t.write("RIFF", 0); t.writeUInt32LE(36 + donnees.length, 4); t.write("WAVE", 8); t.write("fmt ", 12);
  t.writeUInt32LE(16, 16); t.writeUInt16LE(1, 20); t.writeUInt16LE(1, 22); t.writeUInt32LE(taux, 24);
  t.writeUInt32LE(taux * 2, 28); t.writeUInt16LE(2, 32); t.writeUInt16LE(16, 34); t.write("data", 36); t.writeUInt32LE(donnees.length, 40);
  return Buffer.concat([t, donnees]);
}

/* Contexte prêt : configuration factice, suivi des flux micro et des URL blob, erreurs JS notées. */
async function nouveauContexte(navigateur, { config = true, profil = null, micro = "factice" } = {}) {
  const context = await navigateur.newContext();
  await context.addInitScript(({ cfg, profil, micro }) => {
    try {
      if (cfg && !localStorage.getItem("bf_cfg")) localStorage.setItem("bf_cfg", JSON.stringify(cfg));
      if (profil && !localStorage.getItem("bf_co_profil")) localStorage.setItem("bf_co_profil", JSON.stringify(profil));
    } catch (e) {}
    window.__flux = []; window.__blobs = { crees: [], revoques: [] };
    const cree = URL.createObjectURL.bind(URL), revoque = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (o) => { const u = cree(o); window.__blobs.crees.push(u); return u; };
    URL.revokeObjectURL = (u) => { window.__blobs.revoques.push(u); return revoque(u); };
    if (navigator.mediaDevices) {
      const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (c) => {
        if (micro === "refuse") throw new DOMException("Permission refusée", "NotAllowedError");
        const s = await gum(c); window.__flux.push(s); return s;
      };
    }
  }, { cfg: config ? CFG : null, profil, micro });
  return context;
}
function suivreErreurs(page) {
  const erreurs = [];
  page.on("pageerror", (e) => erreurs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::ERR/.test(m.text())) erreurs.push(m.text()); });
  return erreurs;
}
const decoder = (b64) => Buffer.from(b64, "base64");

module.exports = { servir, lancer, fauxGitHub, wav, nouveauContexte, suivreErreurs, decoder, CFG, PROPRIO, DEPOT };
