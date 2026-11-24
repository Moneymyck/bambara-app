/* Tests de l'onglet « Apprendre » (collecte de voix), avec un faux GitHub en mémoire.
   Lancer : node --test tests/collecte.test.js
   Aucun appel réel à GitHub, aucune donnée réelle : pseudos et textes inventés. */
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { servir, lancer, fauxGitHub, wav, nouveauContexte, suivreErreurs, decoder } = require("./outils");

let serveur, navigateur;
before(async () => { serveur = await servir(); navigateur = await lancer(); });
after(async () => { await navigateur.close(); serveur.fermer(); });

const CLES_FICHE = ["version", "id", "bm", "fr", "type", "fichier", "mime", "duree_s", "locuteur", "region", "consentement", "app_version", "cree_le"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ID = /^[A-Za-z0-9-]+$/;

async function ouvrirApprendre(page) {
  await page.goto(serveur.url);
  await page.click('nav button[data-vue="collecte"]');
  await page.waitForSelector("#v-collecte.active");
}
async function enregistrer(page, ms = 1200) {
  await page.click("#co-micro");
  await page.waitForSelector("#co-micro.enreg");
  await page.waitForTimeout(ms);
  await page.click("#co-micro");
  await page.waitForSelector("#co-ecoute:not([hidden])");
}
async function remplir(page, { bm = "i ni ce", fr = "merci", pseudo = "Awa Ɲuman", region = "Ségou", accord = true } = {}) {
  await page.fill("#co-bm", bm);
  await page.fill("#co-fr", fr);
  await page.fill("#co-pseudo", pseudo);
  await page.fill("#co-region", region);
  if (accord) await page.check("#co-accord");
}
const compteFile = (page) => page.evaluate(() => new Promise((ok) => {
  const r = indexedDB.open("bf_collecte", 1);
  r.onsuccess = () => { const q = r.result.transaction("file").objectStore("file").getAll(); q.onsuccess = () => ok(q.result.map((x) => ({ id: x.id, audioEnvoye: x.audioEnvoye, taille: x.donnees.byteLength, fiche: x.fiche }))); };
  r.onerror = () => ok(null);
}));
const fichePut = (gh) => gh.puts().filter((r) => /fiche\.json$/.test(r.chemin));
const audioPut = (gh) => gh.puts().filter((r) => /\/audio\.[a-z0-9]+$/.test(r.chemin));

test("enregistrement, lettres spéciales, envoi audio puis fiche.json", async () => {
  const context = await nouveauContexte(navigateur);
  const gh = await fauxGitHub(context);
  const page = await context.newPage();
  const erreurs = suivreErreurs(page);
  await ouvrirApprendre(page);
  await page.waitForSelector("#co-liste >> text=Aucune contribution");
  assert.equal(await page.isVisible("#co-depot"), false, "le repli fichier reste caché quand le micro marche");

  // 1. Enregistrer, vérifier le minuteur, l'arrêt des pistes, puis « Refaire »
  await page.click("#co-micro");
  await page.waitForSelector("#co-micro.enreg");
  await page.waitForTimeout(1400);
  assert.notEqual(await page.textContent("#co-chrono"), "0:00", "le minuteur avance");
  await page.click("#co-micro");
  await page.waitForSelector("#co-ecoute:not([hidden])");
  assert.match(await page.getAttribute("#co-lecteur", "src"), /^blob:/);
  assert.ok(await page.evaluate(() => window.__flux.length === 1 && window.__flux[0].getTracks().every((t) => t.readyState === "ended")), "pistes du micro arrêtées");
  const urlPremier = await page.getAttribute("#co-lecteur", "src");
  await page.click("#co-refaire");
  assert.equal(await page.isVisible("#co-ecoute"), false);
  assert.equal(await page.textContent("#co-chrono"), "0:00");
  assert.ok(await page.evaluate((u) => window.__blobs.revoques.includes(u), urlPremier), "URL blob libérée après Refaire");
  await enregistrer(page, 1500);

  // 2. Saisie : type Mot, lettres insérées au curseur sans perdre le focus
  await page.click('label:has(input[name="co-type"][value="mot"])');
  await page.fill("#co-bm", "ka");
  await page.evaluate(() => { const t = document.querySelector("#co-bm"); t.focus(); t.setSelectionRange(0, 0); });
  await page.click('#v-collecte .lettre[data-c="Ɲ"]');
  await page.click('#v-collecte .lettre[data-c="ɔ"]');
  assert.equal(await page.inputValue("#co-bm"), "Ɲɔka");
  assert.deepEqual(await page.evaluate(() => [document.activeElement.id, document.activeElement.selectionStart]), ["co-bm", 2]);
  await page.keyboard.press("End");
  await page.keyboard.type(" s");
  await page.click('#v-collecte .lettre[data-c="ɛ"]');
  await page.click('#v-collecte .lettre[data-c="ŋ"]');
  assert.equal(await page.inputValue("#co-bm"), "Ɲɔka sɛŋ");
  assert.equal(await page.getAttribute("#co-bm", "lang"), "bm");
  assert.equal(await page.getAttribute("#co-bm", "autocorrect"), "off");
  assert.equal(await page.getAttribute("#co-bm", "spellcheck"), "false");
  await page.fill("#co-fr", "  Bonjour à   toi, ça va  ");       // accents décomposés exprès
  await page.fill("#co-pseudo", "Awa Ɲuman");
  await page.fill("#co-region", "Ségou");

  // 3. Case d'accord obligatoire
  await page.click("#co-envoyer");
  await page.waitForSelector("#co-retour >> text=Coche la case");
  assert.equal(gh.puts().length, 0);
  await page.check("#co-accord");
  await page.click("#co-envoyer");
  await page.waitForSelector("#co-retour >> text=Contribution envoyée");

  // 4. Ordre et contenu des écritures
  const puts = gh.puts();
  assert.equal(puts.length, 2, "un PUT audio puis un PUT fiche");
  const [pa, pf] = puts;
  const m = /^collecte\/([^/]+)\/audio\.m4a$/.exec(pa.chemin);
  assert.ok(m, "audio d'abord, en m4a (audio/mp4 choisi en premier) : " + pa.chemin);
  const id = m[1];
  assert.match(id, ID);
  assert.equal(pf.chemin, `collecte/${id}/fiche.json`, "fiche.json ensuite");
  const audio = decoder(pa.corps.content);
  assert.ok(audio.length > 500, "audio non vide");
  assert.equal(audio.subarray(4, 8).toString("latin1"), "ftyp", "conteneur MP4");
  assert.equal(pa.corps.message, "Collecte audio " + id);
  const fiche = JSON.parse(decoder(pf.corps.content).toString("utf8"));
  assert.deepEqual(Object.keys(fiche), CLES_FICHE);
  assert.equal(fiche.version, 1);
  assert.equal(fiche.id, id);
  assert.equal(fiche.bm, "Ɲɔka sɛŋ");
  assert.equal(fiche.fr, "Bonjour à toi, ça va");
  assert.equal(fiche.fr, fiche.fr.normalize("NFC"));
  assert.equal(fiche.type, "mot");
  assert.equal(fiche.fichier, "audio.m4a");
  assert.match(fiche.mime, /^audio\/mp4/);
  assert.equal(typeof fiche.duree_s, "number");
  assert.ok(fiche.duree_s > 1 && fiche.duree_s <= 30, "durée " + fiche.duree_s);
  assert.equal(fiche.locuteur, "Awa Ɲuman");
  assert.equal(fiche.region, "Ségou");
  assert.equal(fiche.region, fiche.region.normalize("NFC"));
  assert.equal(fiche.consentement.version, "2026-11-24");
  assert.match(fiche.consentement.accepte_le, ISO);
  assert.equal(typeof fiche.app_version, "string");
  assert.ok(fiche.app_version.length > 0);
  assert.match(fiche.cree_le, ISO);
  assert.ok(!gh.requetes.some((r) => r.chemin && /reveil\.json|job\.json/.test(r.chemin)), "le robot n'est pas réveillé");

  // 5. File vidée, formulaire prêt pour la suivante, liste à jour
  assert.deepEqual(await compteFile(page), []);
  assert.equal(await page.textContent("#co-attente"), "");
  assert.equal(await page.inputValue("#co-bm"), "");
  assert.equal(await page.inputValue("#co-fr"), "");
  assert.equal(await page.isVisible("#co-ecoute"), false);
  const carte = page.locator(`#co-liste .contrib[data-id="${id}"]`);
  await carte.waitFor();
  assert.equal(await carte.locator(".puce").textContent(), "À vérifier");
  assert.match(await carte.innerText(), /Ta contribution/);
  assert.equal(await carte.locator("[data-avis]:visible").count(), 0, "pas de bouton de validation sur sa propre contribution");

  // 6. Pseudo, région et accord gardés sur le téléphone
  await page.reload();
  assert.equal(await page.inputValue("#co-pseudo"), "Awa Ɲuman");
  assert.equal(await page.inputValue("#co-region"), "Ségou");
  assert.equal(await page.isChecked("#co-accord"), true);
  assert.deepEqual(erreurs, []);
  await context.close();
});

test("arrêt automatique à 30 s", async () => {
  const context = await nouveauContexte(navigateur);
  await fauxGitHub(context);
  const page = await context.newPage();
  await page.clock.install();
  await ouvrirApprendre(page);
  await page.click("#co-micro");
  await page.waitForSelector("#co-micro.enreg");
  await page.waitForTimeout(800);                 // un peu de vrai son
  await page.clock.runFor(29000);
  assert.equal(await page.textContent("#co-chrono"), "0:29");
  assert.ok(await page.isVisible("#co-micro.enreg"), "toujours en cours à 29 s");
  await page.clock.runFor(1500);
  await page.waitForSelector("#co-ecoute:not([hidden])");
  assert.equal(await page.textContent("#co-chrono"), "0:30");
  assert.ok(await page.evaluate(() => window.__flux[0].getTracks().every((t) => t.readyState === "ended")));
  assert.match(await page.textContent("#co-etat"), /30 s/);
  await context.close();
});

test("micro refusé : repli « Choisir un fichier audio »", async () => {
  const context = await nouveauContexte(navigateur, { micro: "refuse" });
  const gh = await fauxGitHub(context);
  const page = await context.newPage();
  const erreurs = suivreErreurs(page);
  await ouvrirApprendre(page);
  await page.click("#co-micro");
  await page.waitForSelector("#co-depot:not([hidden])");
  assert.match(await page.textContent("#co-etat"), /Micro refusé/);
  await page.setInputFiles("#co-fichier", { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("rien") });
  assert.match(await page.textContent("#co-etat"), /Format non pris en charge/);
  await page.setInputFiles("#co-fichier", { name: "essai.wav", mimeType: "audio/wav", buffer: wav(2) });
  await page.waitForSelector("#co-ecoute:not([hidden])");
  assert.match(await page.textContent("#co-etat"), /2 s/);
  await remplir(page, { bm: "a bɛ taa", fr: "il s'en va" });
  await page.click("#co-envoyer");
  await page.waitForSelector("#co-retour >> text=Contribution envoyée");
  const [pa, pf] = gh.puts();
  assert.match(pa.chemin, /^collecte\/[A-Za-z0-9-]+\/audio\.wav$/);
  assert.equal(decoder(pa.corps.content).subarray(0, 4).toString("latin1"), "RIFF");
  const fiche = JSON.parse(decoder(pf.corps.content).toString("utf8"));
  assert.equal(fiche.fichier, "audio.wav");
  assert.equal(fiche.mime, "audio/wav");
  assert.equal(fiche.duree_s, 2);
  assert.equal(fiche.type, "phrase");
  assert.deepEqual(erreurs, []);
  await context.close();
});

test("hors ligne : mise en file, compteur, puis reprise au retour du réseau", async () => {
  const context = await nouveauContexte(navigateur);
  const gh = await fauxGitHub(context);
  const page = await context.newPage();
  await ouvrirApprendre(page);
  await page.waitForSelector("#co-liste .vide");
  await context.setOffline(true);
  await enregistrer(page);
  await remplir(page, { bm: "n bɛ na", fr: "je viens" });
  await page.click("#co-envoyer");
  await page.waitForSelector("#co-retour >> text=hors ligne");
  assert.equal(await page.textContent("#co-attente"), "1 en attente d'envoi");
  // une deuxième pendant la coupure
  await enregistrer(page);
  await remplir(page, { bm: "a ka ɲi", fr: "c'est bien" });
  await page.click("#co-envoyer");
  await page.waitForFunction(() => document.querySelector("#co-attente").textContent === "2 en attente d'envoi");
  assert.equal(gh.puts().length, 0, "rien n'est envoyé hors ligne");
  const file = await compteFile(page);
  assert.equal(file.length, 2);
  assert.ok(file.every((r) => r.taille > 0 && r.audioEnvoye === false && r.fiche.version === 1));

  await context.setOffline(false);                 // l'événement « online » relance l'envoi
  await page.waitForFunction(() => document.querySelector("#co-attente").textContent === "", null, { timeout: 15000 });
  const chemins = gh.puts().map((r) => r.chemin);
  const [a, b] = file.map((r) => r.id);
  assert.deepEqual(chemins, [`collecte/${a}/audio.m4a`, `collecte/${a}/fiche.json`, `collecte/${b}/audio.m4a`, `collecte/${b}/fiche.json`]);
  assert.deepEqual(await compteFile(page), []);
  await page.waitForSelector("#co-retour >> text=2 contributions envoyées");
  await context.close();
});

test("échec de fiche.json : la contribution reste en file, l'audio n'est pas renvoyé", async () => {
  const context = await nouveauContexte(navigateur);
  const gh = await fauxGitHub(context);
  gh.panne = (r) => (r.methode === "PUT" && /fiche\.json$/.test(r.chemin) ? 500 : undefined);
  const page = await context.newPage();
  await ouvrirApprendre(page);
  await enregistrer(page);
  await remplir(page);
  await page.click("#co-envoyer");
  await page.waitForSelector("#co-retour >> text=L'envoi a échoué", { timeout: 15000 });
  assert.equal(audioPut(gh).length, 1);
  assert.equal(fichePut(gh).length, 3, "3 essais pour la fiche");
  const file = await compteFile(page);
  assert.equal(file.length, 1);
  assert.equal(file[0].audioEnvoye, true, "l'audio est noté comme envoyé");
  assert.equal(await page.textContent("#co-attente"), "1 en attente d'envoi");

  gh.panne = null;                                 // la reprise se fait à l'ouverture de l'onglet
  await page.click('nav button[data-vue="lexique"]');
  await page.click('nav button[data-vue="collecte"]');
  await page.waitForFunction(() => document.querySelector("#co-attente").textContent === "", null, { timeout: 15000 });
  assert.equal(audioPut(gh).length, 1, "l'audio n'est pas renvoyé");
  assert.equal(fichePut(gh).length, 4);
  assert.ok(gh.texte(`collecte/${file[0].id}/fiche.json`));
  await context.close();
});

test("coupure pendant l'envoi : 3 essais, puis reprise au démarrage ; réponse perdue sans doublon", async () => {
  const context = await nouveauContexte(navigateur);
  const gh = await fauxGitHub(context);
  gh.panne = (r) => (r.methode === "PUT" ? "couper" : undefined);
  const page = await context.newPage();
  await ouvrirApprendre(page);
  await enregistrer(page);
  await remplir(page);
  await page.click("#co-envoyer");
  await page.waitForSelector("#co-retour >> text=Envoi impossible pour l'instant", { timeout: 15000 });
  assert.equal(audioPut(gh).length, 3, "3 essais");
  assert.equal(fichePut(gh).length, 0, "pas de fiche sans audio");
  const [rec] = await compteFile(page);
  assert.ok(rec);

  // Au redémarrage : le 1er PUT audio est enregistré mais sa réponse se perd (422 au 2e essai)
  let coupe = false;
  gh.panne = (r) => {
    if (r.methode === "PUT" && /audio/.test(r.chemin) && !coupe) { coupe = true; return "stocker-puis-couper"; }
    return undefined;
  };
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#co-attente").textContent === "", null, { timeout: 15000 });
  assert.ok(gh.fichiers.has(`collecte/${rec.id}/audio.m4a`));
  const fiche = JSON.parse(gh.texte(`collecte/${rec.id}/fiche.json`));
  assert.equal(fiche.id, rec.id);
  assert.deepEqual(await compteFile(page), []);
  await context.close();
});

test("liste : 30 plus récentes, statuts, écoute, Juste / Corriger / Faux", async () => {
  const fiche = (id, locuteur, bm, fr, extra) => Object.assign({ version: 1, id, bm, fr, type: "phrase", fichier: "audio.wav", mime: "audio/wav", duree_s: 1, locuteur, region: "", consentement: { version: "2026-11-24", accepte_le: "2026-11-20T08:00:00.000Z" }, app_version: "test", cree_le: "2026-11-20T08:00:00.000Z" }, extra);
  const val = (valide, par, date, extra) => Object.assign({ valide, par, date }, extra);
  const depart = {};
  const ajouter = (id, f, vals) => {
    depart[`collecte/${id}/audio.wav`] = wav(1);
    if (f) depart[`collecte/${id}/fiche.json`] = f;
    for (const [qui, v] of Object.entries(vals || {})) depart[`collecte/${id}/validations/${qui}.json`] = v;
  };
  const A = "20261120-090000-aaaa", B = "20261120-080000-bbbb", C = "20261120-070000-cccc", D = "20261120-060000-dddd",
    E = "20261120-050000-eeee", F = "20261120-040000-ffff", G = "20261120-100000-gggg";
  ajouter(G, null);                                                     // incomplète : pas de fiche
  ajouter(A, fiche(A, "Moussa", "i ni sɔgɔma", "bonjour (le matin)"));
  ajouter(B, fiche(B, "Fanta", "a bɛ taa", "il part"), { moussa: val(true, "Moussa", "2026-11-21T10:00:00Z") });
  ajouter(C, fiche(C, "Fanta", "a ma na", "il est venu"), { moussa: val(true, "Moussa", "2026-11-21T10:00:00Z"), issa: val(false, "Issa", "2026-11-21T11:00:00Z") });
  ajouter(D, fiche(D, "Awa Ɲuman", "n bɛ yan", "je suis là"), { "awa-nyuman": val(true, "Awa Ɲuman", "2026-11-21T10:00:00Z") });
  ajouter(E, fiche(E, "Issa", "a ka di", "c'est bon"), {
    moussa: val(true, "Moussa", "2026-11-21T10:00:00Z", { bm_corrige: "a ka di kosɛbɛ", fr_corrige: "c'est très bon" }),
    fanta: val(true, "Fanta", "2026-11-22T10:00:00Z", { bm_corrige: "a ka di dɛ" }),
  });
  ajouter(F, fiche(F, "Pirate", '<img src=x onerror="window.__xss=1">', "<b>gras</b>"));
  for (let i = 0; i < 26; i++) { const id = `20261001-1000${String(i).padStart(2, "0")}-k${String(i).padStart(3, "0")}`; ajouter(id, fiche(id, "Kadi", "mot " + i, "mot " + i)); }

  const context = await nouveauContexte(navigateur, { profil: { pseudo: "Awa Ɲuman", region: "" } });
  const gh = await fauxGitHub(context, depart);
  const page = await context.newPage();
  const erreurs = suivreErreurs(page);
  await ouvrirApprendre(page);
  await page.waitForSelector("#co-liste .contrib");
  const ids = await page.$$eval("#co-liste .contrib", (els) => els.map((e) => e.dataset.id));
  assert.equal(ids.length, 30, "30 contributions au plus");
  assert.deepEqual(ids.slice(0, 6), [A, B, C, D, E, F], "les plus récentes d'abord, l'incomplète ignorée");
  assert.deepEqual(ids, ids.slice().sort().reverse());
  const carte = (id) => page.locator(`#co-liste .contrib[data-id="${id}"]`);
  const puce = (id) => carte(id).locator(".puce").textContent();
  assert.equal(await puce(A), "À vérifier");
  assert.equal(await puce(B), "Validée");
  assert.equal(await puce(C), "Refusée");
  assert.equal(await puce(D), "À vérifier", "son propre avis ne compte pas");
  assert.equal(await puce(E), "Validée");
  assert.equal(await carte(E).locator(".cbm").textContent(), "a ka di dɛ", "bm de la correction la plus récente");
  assert.equal(await carte(E).locator(".cfr").textContent(), "c'est très bon", "fr de la plus récente qui en a");
  assert.match(await carte(E).textContent(), /Avant correction : a ka di — c'est bon/);
  assert.equal(await carte(F).locator(".cbm").textContent(), '<img src=x onerror="window.__xss=1">', "texte échappé");
  assert.equal(await carte(F).locator("img, b").count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await carte(D).locator("[data-avis]:visible").count(), 0);
  assert.match(await carte(D).innerText(), /Ta contribution/);
  assert.doesNotMatch(await carte(A).innerText(), /Ta contribution/);

  // Écoute
  await carte(A).locator(".co-ecouter").click();
  await carte(A).locator("audio").waitFor();
  const urlAudio = await carte(A).locator("audio").getAttribute("src");
  assert.match(urlAudio, /^blob:/);
  assert.ok(gh.requetes.some((r) => r.chemin === `collecte/${A}/audio.wav` && r.accept.includes("raw")));
  await page.waitForFunction((id) => document.querySelector(`.contrib[data-id="${id}"] audio`).readyState >= 1, A);

  // Juste
  await carte(A).locator('[data-avis="juste"]').click();
  await carte(A).locator(".co-msg >> text=ton avis est enregistré").waitFor();
  let p = gh.puts().at(-1);
  assert.equal(p.chemin, `collecte/${A}/validations/awa-nyuman.json`);
  assert.equal(p.corps.sha, undefined);
  let v = JSON.parse(decoder(p.corps.content).toString("utf8"));
  assert.deepEqual(Object.keys(v), ["valide", "par", "date"]);
  assert.equal(v.valide, true);
  assert.equal(v.par, "Awa Ɲuman");
  assert.match(v.date, ISO);
  assert.equal(await puce(A), "Validée");
  assert.match(await carte(A).innerText(), /Ton avis : juste/);
  assert.equal(await carte(A).locator("audio").getAttribute("src"), urlAudio, "le lecteur reste en place");

  // Faux
  await carte(B).locator('[data-avis="faux"]').click();
  await carte(B).locator(".co-msg >> text=ton avis est enregistré").waitFor();
  v = JSON.parse(decoder(gh.puts().at(-1).corps.content).toString("utf8"));
  assert.equal(v.valide, false);
  assert.equal(await puce(B), "Refusée");

  // Corriger (change d'avis sur A : le fichier existe, le sha est envoyé)
  await carte(A).locator('[data-avis="corriger"]').click();
  await carte(A).locator(".cf-ok").click();
  await carte(A).locator(".co-msg >> text=Rien n'a changé").waitFor();
  await carte(A).locator(".cf-bm").fill("aw ni s");
  await carte(A).locator(".cf-bm").focus();
  await carte(A).locator('.lettre[data-c="ɔ"]').click();
  await carte(A).locator(".cf-bm").press("End");
  await carte(A).locator(".cf-bm").type("gɔma");
  await carte(A).locator(".cf-ok").click();
  await carte(A).locator(".co-msg >> text=ton avis est enregistré").waitFor();
  p = gh.puts().at(-1);
  assert.equal(p.chemin, `collecte/${A}/validations/awa-nyuman.json`);
  assert.ok(p.corps.sha, "sha envoyé pour remplacer son avis");
  v = JSON.parse(decoder(p.corps.content).toString("utf8"));
  assert.deepEqual(Object.keys(v), ["valide", "bm_corrige", "par", "date"], "fr inchangé : pas de fr_corrige");
  assert.equal(v.bm_corrige, "aw ni sɔgɔma");
  assert.equal(await carte(A).locator(".cbm").textContent(), v.bm_corrige);
  assert.match(await carte(A).innerText(), /Ton avis : corrigé/);
  assert.equal(await puce(A), "Validée");

  // Autre pseudo : les boutons suivent l'auteur
  await page.fill("#co-pseudo", "Moussa");
  assert.equal(await carte(A).locator("[data-avis]:visible").count(), 0, "A est à Moussa");
  assert.equal(await carte(D).locator("[data-avis]:visible").count(), 3);
  // Pas de pseudo : on le demande
  await page.fill("#co-pseudo", "");
  const nPuts = gh.puts().length;
  await carte(C).locator('[data-avis="juste"]').click();
  await carte(C).locator(".co-msg >> text=Écris d'abord ton pseudo").waitFor();
  assert.equal(gh.puts().length, nPuts);

  // URL blob libérées en quittant l'onglet
  await page.click('nav button[data-vue="lexique"]');
  assert.ok(await page.evaluate((u) => window.__blobs.revoques.includes(u), urlAudio));
  assert.deepEqual(erreurs, []);
  await context.close();
});
