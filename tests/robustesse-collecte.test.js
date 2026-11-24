/* Non-régression des corrections de relecture de l'onglet « Apprendre » :
   dépôt privé obligatoire et file liée à son dépôt, accord par personne, reprise automatique,
   coût en requêtes et quota, liste non redessinée pendant une correction, IndexedDB fermée,
   fichier qui n'est pas un son. Faux GitHub en mémoire, aucune donnée réelle.
   Lancer : node --test tests/robustesse-collecte.test.js */
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { servir, lancer, fauxGitHub, wav, nouveauContexte, suivreErreurs, decoder, DEPOT } = require("./outils");

let serveur, navigateur;
before(async () => { serveur = await servir(); navigateur = await lancer(); });
after(async () => { await navigateur.close(); serveur.fermer(); });

async function ouvrirApprendre(page) {
  await page.goto(serveur.url);
  await page.click('nav button[data-vue="collecte"]');
  await page.waitForSelector("#v-collecte.active");
}
async function enregistrer(page, ms = 900) {
  await page.click("#co-micro");
  await page.waitForSelector("#co-micro.enreg");
  await page.waitForTimeout(ms);
  await page.click("#co-micro");
  await page.waitForSelector("#co-ecoute:not([hidden])");
}
async function remplir(page, { bm = "i ni ce", fr = "merci", pseudo = "Awa", accord = true } = {}) {
  await page.fill("#co-bm", bm);
  await page.fill("#co-fr", fr);
  await page.fill("#co-pseudo", pseudo);
  if (accord) await page.check("#co-accord");
}
const compteFile = (page) => page.evaluate(() => new Promise((ok) => {
  const r = indexedDB.open("bf_collecte", 1);
  r.onsuccess = () => { const q = r.result.transaction("file").objectStore("file").getAll(); q.onsuccess = () => { ok(q.result.map((x) => ({ id: x.id, depot: x.depot }))); r.result.close(); }; };
  r.onerror = () => ok(null);
}));
const attente = (page, texte) => page.waitForFunction((t) => document.querySelector("#co-attente").textContent === t, texte, { timeout: 15000 });
const fiches = (gh) => gh.puts().filter((r) => /fiche\.json$/.test(r.chemin)).map((r) => JSON.parse(decoder(r.corps.content).toString("utf8")));
const FICHE = (id, locuteur, bm, fr) => ({ version: 1, id, bm, fr, type: "phrase", fichier: "audio.wav", mime: "audio/wav", duree_s: 1, locuteur, region: "", consentement: { version: "2026-11-24", accepte_le: "2026-11-20T08:00:00.000Z" }, app_version: "test", cree_le: "2026-11-20T08:00:00.000Z" });

test("dépôt public : rien ne part, la file reste intacte ; envoi dès que le dépôt est privé", async () => {
  const context = await nouveauContexte(navigateur);
  const gh = await fauxGitHub(context);
  gh.prives[DEPOT] = false;
  const page = await context.newPage();
  const erreurs = suivreErreurs(page);
  await ouvrirApprendre(page);
  await enregistrer(page);
  await remplir(page);
  await page.click("#co-envoyer");
  await page.waitForSelector("#co-retour >> text=Le dépôt n'est pas privé : rien n'est envoyé");
  assert.equal(gh.puts().length, 0);
  assert.equal(await page.textContent("#co-attente"), "1 en attente d'envoi");
  const [rec] = await compteFile(page);
  assert.deepEqual(rec.depot, { owner: "proprio-test", repo: DEPOT }, "le dépôt est fixé dans la file");

  await page.click('nav button[data-vue="reglages"]');
  await page.click("#c-sauver");
  await page.waitForSelector("#c-retour >> text=ce dépôt est public");
  await page.waitForTimeout(500);
  assert.equal(gh.puts().length, 0, "« Enregistrer et tester » ne vide pas la file vers un dépôt public");
  // visibilité retrouvée : contrôle refait, toujours rien
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(500);
  assert.equal(gh.puts().length, 0);

  gh.prives[DEPOT] = true;                         // le propriétaire passe le dépôt en privé
  await page.click("#c-sauver");
  await page.waitForSelector("#c-retour >> text=privé ✓");
  await attente(page, "");
  assert.deepEqual(gh.puts().map((r) => r.chemin), [`collecte/${rec.id}/audio.m4a`, `collecte/${rec.id}/fiche.json`]);
  assert.deepEqual(erreurs, []);
  await context.close();
});

test("la file part vers le dépôt choisi à l'enregistrement, jamais vers le nouveau dépôt des Réglages", async () => {
  const context = await nouveauContexte(navigateur);
  const gh = await fauxGitHub(context);
  const page = await context.newPage();
  await ouvrirApprendre(page);
  await page.waitForSelector("#co-liste .vide");
  await context.setOffline(true);
  await enregistrer(page);
  await remplir(page);
  await page.click("#co-envoyer");
  await attente(page, "1 en attente d'envoi");
  const [rec] = await compteFile(page);
  // Réglages changés vers bambara-app (public) pendant la coupure
  await page.click('nav button[data-vue="reglages"]');
  await page.fill("#c-repo", "bambara-app");
  await page.click("#c-sauver");
  await page.waitForSelector("#c-retour .msg");
  await page.click('nav button[data-vue="collecte"]');
  await context.setOffline(false);
  await attente(page, "");
  const puts = gh.puts();
  assert.ok(puts.length >= 2 && puts.every((r) => r.depot === DEPOT), "PUT seulement vers " + DEPOT + " : " + JSON.stringify(puts.map((r) => r.depot)));
  assert.equal(puts.at(-1).chemin, `collecte/${rec.id}/fiche.json`);
  // une nouvelle voix, enregistrée pour bambara-app (public), ne part pas
  await enregistrer(page);
  await remplir(page, { bm: "a bɛ taa", fr: "il part" });
  await page.click("#co-envoyer");
  await page.waitForSelector("#co-retour >> text=Le dépôt n'est pas privé");
  assert.ok(!gh.requetes.some((r) => r.methode === "PUT" && r.depot === "bambara-app"));
  assert.equal(await page.textContent("#co-attente"), "1 en attente d'envoi");
  await context.close();
});

test("accord par personne : un autre pseudo doit cocher lui-même, avec sa propre date", async () => {
  const context = await nouveauContexte(navigateur);
  const gh = await fauxGitHub(context);
  const page = await context.newPage();
  await ouvrirApprendre(page);
  await page.fill("#co-pseudo", "");
  await page.click("#co-accord");                  // l'appli la décoche aussitôt
  assert.equal(await page.isChecked("#co-accord"), false, "pas d'accord sans pseudo");
  await page.waitForSelector("#co-retour >> text=Écris d'abord ton pseudo");

  await enregistrer(page);
  await remplir(page, { pseudo: "Awa" });
  await page.click("#co-envoyer");
  await page.waitForSelector("#co-retour >> text=Contribution envoyée");
  await page.waitForTimeout(30);
  await page.fill("#co-pseudo", "Issa");           // téléphone partagé
  assert.equal(await page.isChecked("#co-accord"), false, "la case se décoche pour un autre pseudo");
  assert.equal(await page.evaluate(() => localStorage.getItem("bf_co_accord")), "null");
  await enregistrer(page);
  await page.fill("#co-bm", "a bɛ na"); await page.fill("#co-fr", "il vient");
  await page.click("#co-envoyer");
  await page.waitForSelector("#co-retour >> text=Coche la case");
  assert.equal(gh.puts().length, 2, "rien n'est envoyé sans l'accord d'Issa");
  // accord ancien (sans pseudo) forcé : refusé aussi
  await page.evaluate(() => localStorage.setItem("bf_co_accord", JSON.stringify({ version: "2026-11-24", accepte_le: "2026-11-01T00:00:00.000Z" })));
  await page.evaluate(() => { document.querySelector("#co-accord").checked = true; });
  await page.click("#co-envoyer");
  await page.waitForSelector("#co-retour >> text=Coche la case");
  assert.equal(gh.puts().length, 2);
  assert.equal(await page.isChecked("#co-accord"), false);
  await page.check("#co-accord");
  await page.click("#co-envoyer");
  await page.waitForSelector("#co-retour >> text=Contribution envoyée");
  const [awa, issa] = fiches(gh);
  assert.equal(awa.locuteur, "Awa"); assert.equal(issa.locuteur, "Issa");
  assert.ok(Date.parse(issa.consentement.accepte_le) > Date.parse(awa.consentement.accepte_le), "date d'accord propre à Issa");
  assert.ok(Date.parse(issa.consentement.accepte_le) > Date.parse(awa.cree_le), "Issa a coché après l'envoi d'Awa");
  assert.deepEqual(Object.keys(issa.consentement), ["version", "accepte_le"], "contrat inchangé");
  await ouvrirApprendre(page);
  assert.equal(await page.isChecked("#co-accord"), true, "l'accord d'Issa est gardé pour Issa");
  await page.fill("#co-pseudo", "Awa");
  assert.equal(await page.isChecked("#co-accord"), false, "…mais pas pour Awa");
  await context.close();
});

test("reprise automatique après un échec réseau (30 s, puis 2 min) et au retour de l'appli", async () => {
  const context = await nouveauContexte(navigateur);
  const gh = await fauxGitHub(context);
  gh.panne = (r) => (r.methode === "PUT" ? "couper" : undefined);
  const page = await context.newPage();
  await page.clock.install();
  await ouvrirApprendre(page);
  await enregistrer(page);
  await remplir(page);
  await page.click("#co-envoyer");
  const avancer = async (cond, pas = 1000, max = 400) => {
    for (let i = 0; i < max; i++) { if (await page.evaluate(cond)) return; await page.clock.runFor(pas); await page.waitForTimeout(20); }
    throw new Error("condition jamais atteinte : " + cond);
  };
  await avancer(() => /nouvel essai dans 30 s/.test(document.querySelector("#co-retour").textContent), 500);
  assert.equal(gh.puts().length, 3, "3 essais");
  await page.clock.runFor(25000); await page.waitForTimeout(200);
  assert.equal(gh.puts().length, 3, "pas avant 30 s");
  await avancer(() => /nouvel essai dans 2 min/.test(document.querySelector("#co-retour").textContent), 500);
  assert.equal(gh.puts().length, 6, "2e série d'essais après 30 s");
  gh.panne = null;                                 // réseau rendu ; l'appli revient au premier plan
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await avancer(() => document.querySelector("#co-attente").textContent === "", 500);
  assert.equal(gh.puts().filter((r) => /fiche\.json$/.test(r.chemin)).length, 1);
  assert.match(await page.textContent("#co-retour"), /Contribution envoyée/);
  await context.close();
});

test("coût : arbre en un appel, cache, aucune relecture après un envoi ; quota expliqué", async () => {
  const depart = {};
  for (let i = 0; i < 40; i++) {
    const id = `20261001-1000${String(i).padStart(2, "0")}-q${String(i).padStart(3, "0")}`;
    depart[`collecte/${id}/audio.wav`] = wav(0.2);
    depart[`collecte/${id}/fiche.json`] = FICHE(id, "Kadi", "mot " + i, "mot " + i);
    depart[`collecte/${id}/validations/moussa.json`] = { valide: true, par: "Moussa", date: "2026-11-21T10:00:00Z" };
  }
  depart["lexique_argot.csv"] = "mot;sens;note\n";
  const context = await nouveauContexte(navigateur, { profil: { pseudo: "Awa", region: "" } });
  const gh = await fauxGitHub(context, depart);
  const page = await context.newPage();
  const erreurs = suivreErreurs(page);
  await ouvrirApprendre(page);
  await page.waitForFunction(() => document.querySelectorAll("#co-liste .contrib").length === 30);
  const n1 = gh.requetes.length;
  assert.ok(n1 <= 2 + 30 + 30 + 1, "1re ouverture : " + n1 + " requêtes");
  assert.equal(gh.requetes.filter((r) => r.arbre).length, 1, "un seul appel d'arbre");
  assert.equal(await page.locator(".contrib .puce").first().textContent(), "Validée");

  await page.click('nav button[data-vue="lexique"]');
  await page.waitForTimeout(300);
  const n2 = gh.requetes.length;
  await page.click('nav button[data-vue="collecte"]');
  await page.waitForFunction(() => document.querySelectorAll("#co-liste .contrib").length === 30);
  assert.equal(gh.requetes.length - n2, 2, "2e ouverture : racine + arbre seulement (fiches et avis en cache)");

  const n3 = gh.requetes.length;
  await enregistrer(page);
  await remplir(page, { pseudo: "Awa" });
  await page.click("#co-envoyer");
  await page.waitForSelector("#co-retour >> text=Contribution envoyée");
  await page.waitForTimeout(300);
  const envoi = gh.requetes.slice(n3).map((r) => r.methode + " " + (r.chemin ?? r.url));
  assert.equal(envoi.length, 3, "contrôle du dépôt + 2 PUT : " + JSON.stringify(envoi));
  assert.equal(await page.locator("#co-liste .contrib").count(), 31, "la nouvelle carte est ajoutée sur place");
  assert.match(await page.locator("#co-liste .contrib").first().innerText(), /Ta contribution/);

  // arbre tronqué : ancienne lecture, toujours 30 cartes
  gh.arbreTronque = true;
  await page.click("#co-rafraichir");
  await page.waitForFunction(() => document.querySelectorAll("#co-liste .contrib").length === 30);

  // quota épuisé : message clair, pas « permissions du jeton »
  gh.panne = () => ({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) } });
  await page.click("#co-rafraichir");
  await page.waitForSelector("#co-liste >> text=Trop de demandes à GitHub");
  assert.match(await page.textContent("#co-liste"), /Réessaie dans (9|10) min/);
  assert.doesNotMatch(await page.textContent("#co-liste"), /permissions/);
  await enregistrer(page);
  await remplir(page, { bm: "a bɛ taa", fr: "il part" });
  await page.click("#co-envoyer");
  await page.waitForSelector("#co-retour >> text=Trop de demandes");
  assert.match(await page.textContent("#co-retour"), /nouvel essai dans 30 s/);
  assert.equal(await page.textContent("#co-attente"), "1 en attente d'envoi");
  assert.deepEqual(erreurs, []);
  await context.close();
});

test("un envoi qui se termine ne ferme ni la correction en cours ni l'écoute ; avis retrouvé après rechargement", async () => {
  const A = "20261120-090000-aaaa";
  const context = await nouveauContexte(navigateur, { profil: { pseudo: "Awa", region: "" } });
  const gh = await fauxGitHub(context, { [`collecte/${A}/audio.wav`]: wav(3), [`collecte/${A}/fiche.json`]: FICHE(A, "Moussa", "i ni sɔgɔma", "bonjour") });
  const page = await context.newPage();
  const erreurs = suivreErreurs(page);
  await ouvrirApprendre(page);
  const carte = () => page.locator(`#co-liste .contrib[data-id="${A}"]`);
  await carte().waitFor();
  await carte().locator(".co-ecouter").click();
  await carte().locator("audio").waitFor();
  const src = await carte().locator("audio").getAttribute("src");
  await carte().locator('[data-avis="corriger"]').click();
  await carte().locator(".cf-bm").fill("texte corrigé à la main, long à taper");

  gh.retard = (r) => (r.methode === "PUT" && /fiche\.json$/.test(r.chemin) ? 800 : 0);
  await enregistrer(page);
  await remplir(page, { pseudo: "Awa" });
  await page.click("#co-envoyer");
  await page.waitForSelector("#co-retour >> text=Contribution envoyée");
  assert.equal(await carte().locator(".co-form:not([hidden])").count(), 1, "formulaire toujours ouvert");
  assert.equal(await carte().locator(".cf-bm").inputValue(), "texte corrigé à la main, long à taper");
  assert.equal(await carte().locator("audio").getAttribute("src"), src, "lecteur intact");
  assert.equal(await page.locator("#co-liste .contrib").count(), 2);
  assert.notEqual(await page.locator("#co-liste .contrib").first().getAttribute("data-id"), A, "nouvelle carte en tête");

  // avis lent + « Actualiser » pendant l'attente : la carte redessinée reçoit le résultat
  await carte().locator(".cf-annuler").click();
  gh.retard = (r) => (r.methode === "PUT" && /validations/.test(r.chemin) ? 1200 : 0);
  await carte().locator('[data-avis="juste"]').click();
  await page.waitForTimeout(200);
  await page.click("#co-rafraichir");
  await carte().locator(".co-msg >> text=ton avis est enregistré").waitFor({ timeout: 10000 });
  assert.equal(await carte().locator(".puce").textContent(), "Validée");
  assert.match(await carte().innerText(), /Ton avis : juste/);
  assert.deepEqual(erreurs, []);
  await context.close();
});

test("IndexedDB fermée par le téléphone : la file reste visible et durable", async () => {
  const context = await nouveauContexte(navigateur);
  const gh = await fauxGitHub(context);
  const page = await context.newPage();
  await ouvrirApprendre(page);
  await page.waitForSelector("#co-liste .vide");
  await context.setOffline(true);
  await enregistrer(page);
  await remplir(page);
  await page.click("#co-envoyer");
  await attente(page, "1 en attente d'envoi");
  await page.evaluate(async () => (await coDB).close());           // comme iOS en arrière-plan
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(300);
  assert.equal(await page.textContent("#co-attente"), "1 en attente d'envoi", "la contribution stockée reste comptée");
  await enregistrer(page);
  await remplir(page, { bm: "a ka ɲi", fr: "c'est bien" });
  await page.click("#co-envoyer");
  await attente(page, "2 en attente d'envoi");
  assert.equal((await compteFile(page)).length, 2, "la 2e est bien dans IndexedDB, pas seulement en mémoire");
  await context.setOffline(false);
  await attente(page, "");
  assert.equal(gh.puts().length, 4, "les deux partent");
  await context.close();
});

test("stockage indisponible : avertissement durable dans le compteur", async () => {
  const context = await nouveauContexte(navigateur);
  await context.addInitScript(() => { Object.defineProperty(window, "indexedDB", { get() { throw new Error("bloqué"); } }); });
  await fauxGitHub(context);
  const page = await context.newPage();
  await ouvrirApprendre(page);
  await context.setOffline(true);
  await enregistrer(page);
  await remplir(page);
  await page.click("#co-envoyer");
  await page.waitForSelector("#co-retour >> text=hors ligne");
  await page.waitForFunction(() => /seulement en mémoire : garde l'appli ouverte/.test(document.querySelector("#co-attente").textContent));
  assert.match(await page.textContent("#co-attente"), /^1 en attente d'envoi \(1 gardée seulement en mémoire/);
  await context.close();
});

test("fichier choisi : son contenu doit être un son, l'extension suit le contenu réel", async () => {
  const context = await nouveauContexte(navigateur, { micro: "refuse" });
  const gh = await fauxGitHub(context);
  const page = await context.newPage();
  await ouvrirApprendre(page);
  await page.click("#co-micro");
  await page.waitForSelector("#co-depot:not([hidden])");
  await page.setInputFiles("#co-fichier", { name: "carte-identite.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("%PDF-1.4 faux document de test") });
  await page.waitForSelector("#co-etat >> text=Ce fichier n'est pas un son.");
  assert.equal(await page.isVisible("#co-ecoute"), false);
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(40)]);
  await page.setInputFiles("#co-fichier", { name: "photo.m4a", mimeType: "audio/mp4", buffer: heic });
  await page.waitForSelector("#co-etat >> text=Ce fichier n'est pas un son.");
  assert.equal(await page.isVisible("#co-ecoute"), false);
  await page.setInputFiles("#co-fichier", { name: "vrai-wav.mp3", mimeType: "audio/mpeg", buffer: wav(1) });
  await page.waitForSelector("#co-ecoute:not([hidden])");
  await remplir(page);
  await page.click("#co-envoyer");
  await page.waitForSelector("#co-retour >> text=Contribution envoyée");
  const [pa] = gh.puts();
  assert.match(pa.chemin, /\/audio\.wav$/);
  const [f] = fiches(gh);
  assert.equal(f.fichier, "audio.wav"); assert.equal(f.mime, "audio/wav");
  await context.close();
});
