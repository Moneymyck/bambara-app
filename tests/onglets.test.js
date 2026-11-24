/* Test rapide des onglets existants (Traduire, Historique, Lexique, Réglages) après l'ajout
   de l'onglet Apprendre. Faux GitHub en mémoire, aucune donnée réelle.
   Lancer : node --test tests/onglets.test.js */
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { servir, lancer, fauxGitHub, wav, nouveauContexte, suivreErreurs, decoder, CFG } = require("./outils");

let serveur, navigateur;
before(async () => { serveur = await servir(); navigateur = await lancer(); });
after(async () => { await navigateur.close(); serveur.fermer(); });

const ID = "20261120-100000-abcd";
const DEPART = {
  [`entrees/${ID}/job.json`]: { fichier: "vocal.ogg", titre: "Vocal d'essai" },
  [`sorties/${ID}/statut.json`]: { statut: "termine", titre: "Vocal d'essai", secondes: 42 },
  [`sorties/${ID}/resultat.json`]: { segments: [{ temps: "0:00", bambara: "i ni ce", francais: "merci", doute: "" }] },
  [`sorties/${ID}/audio_FR.mp3`]: wav(1),
  "lexique_argot.csv": "mot;sens;note\nwari;argent;\n",
  "corpus_perso.jsonl": '{"bm":"a","fr":"b"}\n{"bm":"c","fr":"d"}\n',
};

test("navigation et 4 onglets existants intacts, 5 boutons", async () => {
  const context = await nouveauContexte(navigateur, { config: false });
  const gh = await fauxGitHub(context, DEPART);
  const page = await context.newPage();
  const erreurs = suivreErreurs(page);
  await page.goto(serveur.url);

  const boutons = await page.$$eval("nav button", (bs) => bs.map((b) => [b.dataset.vue, b.textContent.trim()]));
  assert.deepEqual(boutons, [["traduire", "Traduire"], ["historique", "Historique"], ["lexique", "Lexique"], ["collecte", "Apprendre"], ["reglages", "Réglages"]]);
  assert.ok(await page.isVisible("#v-reglages.active"), "sans connexion : Réglages");
  await page.click('nav button[data-vue="collecte"]');
  assert.ok(await page.isVisible("#v-reglages.active"), "Apprendre demande aussi la connexion");
  await page.waitForSelector("#c-retour >> text=Commence par remplir la connexion");

  // Réglages
  await page.fill("#c-token", CFG.token);
  await page.fill("#c-owner", CFG.owner);
  await page.fill("#c-repo", CFG.repo);
  await page.click("#c-sauver");
  await page.waitForSelector("#c-retour >> text=privé ✓");
  assert.match(await page.textContent("#v-reglages"), /Version de l'app : 24\/11/);

  // Historique et détail
  await page.click('nav button[data-vue="historique"]');
  await page.waitForSelector("#liste .envoi");
  assert.match(await page.textContent("#liste"), /Vocal d'essai/);
  assert.match(await page.textContent("#liste .puce"), /Terminé/);
  await page.click("#liste .envoi");
  await page.waitForSelector("#d-segs .seg");
  assert.match(await page.textContent("#d-segs"), /merci/);
  await page.waitForSelector("#d-media audio");
  await page.click("#retour-liste");
  await page.waitForSelector("#v-historique.active");

  // Lexique
  await page.click('nav button[data-vue="lexique"]');
  await page.waitForSelector("#lx-liste .lex");
  assert.match(await page.textContent("#lx-liste"), /wari/);
  await page.waitForSelector("#lx-corpus >> text=Tes phrases corrigées : 2");

  // Traduire : choix d'un fichier (réveil du robot) puis envoi (fichier, puis job.json)
  await page.click('nav button[data-vue="traduire"]');
  await page.setInputFiles("#fichier", { name: "vocal test.ogg", mimeType: "audio/ogg", buffer: Buffer.from("OggS-factice") });
  assert.match(await page.textContent("#depot-titre"), /vocal test\.ogg/);
  await page.fill("#contexte", "essai");
  await page.click("#envoyer");
  await page.waitForSelector("#v-detail.active", { timeout: 10000 });
  const chemins = gh.puts().map((r) => r.chemin);
  assert.ok(chemins.includes("reveil.json"), "réveil du robot toujours fait par Traduire");
  const iFichier = chemins.findIndex((c) => /^entrees\/[^/]+\/vocal_test\.ogg$/.test(c));
  const iJob = chemins.findIndex((c) => /^entrees\/[^/]+\/job\.json$/.test(c));
  assert.ok(iFichier >= 0 && iJob > iFichier, "fichier puis job.json : " + chemins.join(", "));
  const job = JSON.parse(decoder(gh.puts()[iJob].corps.content).toString("utf8"));
  assert.equal(job.contexte, "essai");

  // Apprendre s'ouvre maintenant
  await page.click('nav button[data-vue="collecte"]');
  await page.waitForSelector("#v-collecte.active");
  await page.waitForSelector("#co-liste .vide");
  assert.ok(!gh.requetes.some((r) => r.chemin && r.chemin.startsWith("collecte/") && r.methode === "PUT"));
  assert.deepEqual(erreurs, []);
  await context.close();
});
