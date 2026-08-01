# CLAUDE.md

Contexte et règles de travail pour ce dépôt. À lire intégralement avant toute modification.

---

## 1. Le projet

Simulateur d'ampli guitare électrique **100 % navigateur**, sans DAW, sans VST, sans installation.

**Le scénario cible, qui arbitre toutes les décisions :** on arrive chez quelqu'un qui n'a aucun logiciel audio, on branche la guitare, on ouvre l'URL, on joue dans les 10 secondes.

Trois contraintes non négociables, par ordre de priorité :

1. **Latence.** Cible < 15 ms aller-retour. Au-delà de 25 ms le produit ne remplit plus sa fonction.
2. **Qualité sonore.** Le critère de succès est « ça sonne comme un plugin payant », pas « ça fait du bruit distordu ».
3. **Coût CPU faible.** La machine hôte est inconnue et souvent modeste. Budget : < 25 % d'un cœur sur un laptop milieu de gamme de 2020.

**Coût d'infra : zéro.** Hébergement GitHub Pages, quel que soit le trafic. Seule dépense autorisée : le nom de domaine. Toute proposition impliquant un serveur, une fonction serverless, une base de données ou un service payant est hors sujet.

---

## 2. Stack

| Couche | Choix | Non négociable ? |
|---|---|---|
| Build | Astro + Vite, TypeScript strict | Oui |
| UI applicative | Svelte 5 (îlot unique) | Oui |
| State | nanostores | Non |
| Audio | Web Audio API + AudioWorklet | Oui |
| DSP | C++ → WASM SIMD via Emscripten (RTNeural pour le neuronal) | Oui |
| Prototypage DSP | Faust (`@grame/faustwasm`) | Non |
| Baffle | `ConvolverNode` natif | Non |
| Styles | CSS custom properties + Tailwind | Non |
| Hébergement | GitHub Pages + domaine custom | Oui |
| Analytics | GoatCounter ou Cloudflare Web Analytics | Non |

**Interdits explicites :** React, toute dépendance runtime > 15 kB gzip, WebGL, `ScriptProcessorNode`, `SharedArrayBuffer`, tout package npm de DSP audio non audité.

---

## 3. Règles audio

Ces règles sont la raison d'être du projet. Une PR qui en enfreint une est rejetée, même si elle « marche ».

### Capture

`getUserMedia` doit toujours désactiver le pipeline voix de WebRTC. Sans ça le son est détruit et la latence augmente :

```js
audio: {
  deviceId: { exact: id },
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  voiceIsolation: false,
  channelCount: 1,
  latency: 0,
}
```

### Contexte

- Lire `track.getSettings().sampleRate` **avant** de créer l'`AudioContext`, et créer le contexte à cette fréquence exacte. Un resampler implicite coûte de la latence et de la qualité.
- `new AudioContext({ latencyHint: 0, sampleRate })`. Ne pas utiliser `'interactive'`, qui est plus conservateur.
- Toujours créer le contexte dans un gestionnaire d'événement utilisateur (autoplay policy).

### Worklet

- **Un seul AudioWorkletProcessor pour toute la chaîne.** Pas un node par effet : chaque frontière de node est une copie mémoire.
- Le module WASM est instancié **dans** le `AudioWorkletGlobalScope`. Les bytes sont transférés par `postMessage`, jamais fetch depuis le worklet.
- **Zéro allocation dans `process()`.** Tous les buffers sont pré-alloués à l'init. Pas de `new`, pas de closure créée par appel, pas de `console.log`.
- Aucun accès DOM, aucun `await`, aucune exception dans le chemin audio.
- Paramètres continus (knobs) via `AudioParam` pour bénéficier de l'interpolation sample-accurate. `postMessage` réservé aux changements discrets (changement de preset, chargement d'IR).

### DSP

- **Oversampling 4x minimum autour de toute non-linéarité**, avec filtres demi-bande polyphase. L'aliasing est le premier facteur de « son cheap ». C'est non négociable.
- Modèles neuronaux : LSTM hidden size 20 à 40 maximum. Pas de WaveNet/NAM full size, incompatible avec le budget CPU.
- IR chargées avec `ConvolverNode` en `normalize: false`.
- **Un limiteur en fin de chaîne, toujours actif, non désactivable par l'UI.** Un larsen numérique dans un casque peut blesser.
- Noise gate en début de chaîne, avant le preamp.

### Compilation WASM

```
-O3 -msimd128 -flto -fno-exceptions -fno-rtti
```

Rappel structurel : GitHub Pages ne permet pas de définir les headers COOP/COEP. Donc **pas de threads WASM, pas de `SharedArrayBuffer`**. SIMD fonctionne sans ces headers, c'est là qu'est le gain. Toute proposition d'architecture reposant sur du multithread WASM est à écarter d'emblée.

### Mesure

`baseLatency + outputLatency` doit être calculé, affiché en permanence dans l'UI et loggé. Si le chiffre dépasse 25 ms, l'UI affiche un guide de dépannage (changer de périphérique de sortie, forcer 48 kHz dans les réglages système, fermer les autres onglets).

---

## 4. Règles frontend

- Les pages de contenu envoient **0 kB de JS**. Toute hydratation doit être justifiée.
- L'application est **un seul îlot**, sur une seule route, en `client:only="svelte"`.
- **Knobs et faders : SVG + `transform: rotate()` en CSS.** Jamais de canvas, jamais de sprite sheet. Composité GPU, coût CPU nul.
- **Un seul `<canvas>`** pour toute la visualisation (spectre, oscilloscope), alimenté par un `AnalyserNode` natif, bridé à 30 fps via `requestAnimationFrame`. Suspendu quand l'onglet est caché.
- Interdits en animation : `backdrop-filter`, `filter: blur()`, `box-shadow` animée. Uniquement `transform` et `opacity`.
- Polices self-hostées, woff2, sous-ensemblées, `font-display: swap`. Aucun appel à Google Fonts.
- Le thread principal ne doit jamais bloquer plus de 8 ms : un jank UI se traduit par un dropout audible.

---

## 5. Direction artistique

Référence : **Neural DSP, Archetype Tim Henson**.

- Minimalisme flat assumé. Aucun skeuomorphisme, aucune texture de tolex, aucun reflet chromé.
- Palette très restreinte : un fond clair crème, un gris foncé pour le texte, **une seule** couleur d'accent.
- Typographie géométrique fine, généreusement espacée. Beaucoup d'espace négatif.
- Les knobs sont des arcs fins, pas des boutons 3D.
- Hiérarchie par l'espacement et le poids typographique, pas par des bordures ou des cadres.

Tous les tokens (couleurs, espacements, rayons, durées) sont centralisés en custom properties CSS. Aucune valeur en dur dans les composants.

---

## 6. SEO

L'app elle-même ne rankera jamais. Le trafic vient du contenu satellite, statique, généré au build.

- **Une URL indexable par preset** (`/presets/<slug>`), avec JSON-LD.
- **Une URL par ampli et par pédale modélisés.**
- Guides longue traîne, en priorité : jouer de la guitare sur PC sans interface audio, réduire la latence sans ASIO, ampli guitare gratuit dans le navigateur.
- **i18n FR/EN dès le premier jour.** Le marché anglophone est un ordre de grandeur au-dessus. `hreflang` correct sur chaque page.
- JSON-LD obligatoire : `SoftwareApplication` sur la home, `FAQPage` sur le FAQ, `HowTo` sur les guides.
- Sitemap et OG images générées au build (`@astrojs/sitemap`, Satori).
- Presets partageables par hash d'URL, aucun état utilisateur côté serveur.

Objectif Core Web Vitals : 100/100. C'est atteignable sans effort en Astro statique et c'est un avantage concurrentiel réel face aux sites de plugins.

---

## 7. Compatibilité

| Navigateur | Statut | Attendu |
|---|---|---|
| Chrome / Edge desktop | Cible principale | Tout fonctionne, latence optimale |
| Firefox desktop | Dégradé | Fonctionne, latence supérieure, pas de `setSinkId` |
| Safari desktop | Best effort | Fonctionne, latence médiocre |
| Mobile | Non supporté | Page d'explication, pas de tentative de chargement |

Un écran d'onboarding détecte le navigateur, le périphérique, la fréquence d'échantillonnage, et guide l'utilisateur avant tout chargement du moteur audio.

---

## 8. Conventions de code

- TypeScript `strict`, pas de `any`, pas de `@ts-ignore` sans commentaire justifiant.
- Pas de commentaires qui paraphrasent le code. Les commentaires expliquent le **pourquoi**, en particulier pour les constantes DSP (fréquences de coupure, coefficients, seuils).
- Nommage des fichiers : `kebab-case`. Composants Svelte : `PascalCase.svelte`.
- Un module C++ par bloc DSP, interface C plate exposée à WASM.
- Commits conventionnels (`feat:`, `fix:`, `perf:`, `docs:`).
- Le code C++ du DSP et le code TS ne partagent aucune logique métier : la source de vérité des paramètres est un schéma TS unique, dont le header C++ est **généré**, jamais recopié à la main.

---

## 9. Attentes de collaboration

Quand tu travailles sur ce dépôt :

- **Ne propose jamais une solution nécessitant un backend, un service payant ou des headers HTTP custom.** Contrainte structurelle, pas une préférence.
- **Chiffre l'impact latence et CPU** de toute modification touchant au chemin audio. Une estimation argumentée vaut mieux que rien.
- **Signale les régressions de qualité sonore**, même si le code fonctionne. Un waveshaper sans oversampling « marche » et sonne mal.
- Si une décision d'architecture arbitre entre latence, qualité et CPU, **explicite l'arbitrage** au lieu de trancher silencieusement.
- Préfère supprimer du code à en ajouter. Chaque kilooctet de JS et chaque cycle CPU sont des dettes payées par l'utilisateur, sur une machine qu'on ne choisit pas.
- En cas de doute sur une dépendance : ne pas l'ajouter, demander.
