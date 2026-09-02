# CLAUDE.md

Contexte et règles de travail pour ce dépôt. À lire intégralement avant toute modification.

---

## 1. Le projet

Simulateur d'ampli guitare électrique **100 % navigateur**, sans DAW, sans VST, sans installation.

**Tout part de l'écoute.** Le moteur DSP n'est pas le produit, il est le rendeur qui fabrique le produit : il tourne au build pour produire ce que la majorité des visiteurs entendra, et en temps réel pour la minorité qui branche une guitare. Cette inversion arbitre toute l'architecture.

Le produit a donc **deux chemins de chargement disjoints** :

- **Écouter** — fichiers audio rendus au build. 0 kB de JS, aucun WASM, aucun `AudioContext`, aucune permission micro. Instantané, sur tous les appareils, téléphones compris.
- **Jouer** — le moteur complet. Guitare en main depuis dix minutes, marre d'entendre du bois. C'est le scénario le plus exigeant, pas le plus fréquent.

Trois contraintes non négociables, par ordre de priorité :

1. **Coût CPU.** Dans un AudioWorklet le quantum est figé à 128 frames : il n'existe aucun curseur où échanger de la latence contre du CPU. Dépasser le budget ne produit pas du retard, ça produit un craquement. Le budget CPU **est** le budget de dropouts, et le taux de dropouts est ce qui tue le produit. Budget : < 25 % d'un cœur sur un laptop milieu de gamme de 2020.
2. **Qualité sonore.** Le critère de succès est « ça sonne comme un plugin payant » — appliqué à **un** son, pas à un catalogue. On coupe la largeur, jamais la profondeur. Face au scénario cible, le concurrent n'est pas Neural DSP : c'est le petit combo dans le coin de la pièce et la décision de reposer la guitare. Le référentiel est le son de la guitare débranchée.
3. **Latence.** Secondaire, et re-dérivée : la cible n'est pas le temps réel de studio — l'enregistrement est hors sujet — mais « assez bas pour que le décalage ne se sente pas en jouant ». Le son parcourt 34 cm par ms : jouer à 3 m d'un vrai ampli vaut déjà ~9 ms. Voir le barème à trois paliers en §3.

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
- Paramètres continus (faders) via `AudioParam` pour bénéficier de l'interpolation sample-accurate. `postMessage` réservé aux changements discrets (changement de preset, chargement d'IR) et au retour de mesure ci-dessous.
- **Métrage : RMS par étage calculé dans le worklet** — on y est déjà, c'est gratuit — écrit dans un `Float32Array` pré-alloué et posté à 30 Hz. Trente messages par seconde et quelques dizaines d'octets : négligeable. C'est ce qui alimente le cordon et les meters. **Pas de `SharedArrayBuffer`, pas de COOP/COEP, pas de `coi-serviceworker`, aucune isolation cross-origin nulle part.**

### DSP

- **Oversampling 4x minimum autour de toute non-linéarité**, avec filtres demi-bande polyphase. L'aliasing est le premier facteur de « son cheap ». C'est non négociable.
- **L'oversampling est spatial, pas global.** Uniquement la fenêtre non linéaire — waveshaper et modèle neuronal. Jamais l'EQ, la reverb, le gate ou le comp : ces blocs n'aliasent pas et payer 5x dessus est du gaspillage pur. Coût mesuré d'une chaîne demi-bande à phase linéaire : ~0,3 ms aller-retour, ~5x le CPU du seul étage concerné. Le prix n'est pas en latence, il est en dropouts.
- Modèles neuronaux : **LSTM hidden size 20**. Pas de WaveNet/NAM full size, incompatible avec le budget CPU.
- **La qualité ne s'adapte jamais à la machine.** La complexité du modèle est choisie au build pour la machine plancher, jamais au runtime depuis le headroom mesuré. Raison : un rendu déterministe est la condition pour qu'un tone partagé sonne pareil chez l'autre — une qualité adaptative ferait mentir le tone link, donc la boucle de croissance entière. Corollaire : les machines rapides gardent du headroom inutilisé, aucune dégradation gracieuse n'est possible, et il faut donc un chemin de refus honnête pour la machine qui ne tient pas le budget.
- **Les fichiers pré-rendus au build utilisent exactement les mêmes réglages que le moteur temps réel.** Un rendu hors ligne n'a aucun budget CPU : 16x d'oversampling et un modèle bien plus gros y seraient gratuits et tentants. Le demo sonnerait alors mieux que le temps réel, et le visiteur qui branche sa guitare serait déçu. Headroom délibérément non utilisé, pour la même raison que le tone link doit être déterministe.
- IR chargées avec `ConvolverNode` en `normalize: false`.
- **Un limiteur en fin de chaîne, toujours actif, non désactivable par l'UI.** Un larsen numérique dans un casque peut blesser.
- Noise gate en début de chaîne, avant le preamp.

### Compilation WASM

```
-O3 -msimd128 -flto -fno-exceptions -fno-rtti
```

Rappel structurel : GitHub Pages ne permet pas de définir les headers COOP/COEP. Donc **pas de threads WASM, pas de `SharedArrayBuffer`**. SIMD fonctionne sans ces headers, c'est là qu'est le gain. Toute proposition d'architecture reposant sur du multithread WASM est à écarter d'emblée.

### Mesure

`baseLatency + outputLatency` doit être calculé, affiché en permanence dans l'UI et loggé. Barème à trois paliers :

| Aller-retour mesuré | Comportement |
|---|---|
| < 20 ms | Rien n'est dit. |
| 20 – 35 ms | Le chiffre est affiché, cliquable pour l'explication. Ça se joue. |
| > 35 ms | Message honnête sur la cause matérielle. **Jamais bloquant.** |

**Le vrai critère d'échec n'est pas la milliseconde, c'est la stabilité.** Un décalage constant de 20 ms s'oublie en une minute ; un décalage qui varie ou qui craque est injouable pour toujours. Jitter et dropouts sont les métriques à instrumenter.

Un plancher subsiste malgré tout : dans le scénario cible on entend l'acoustique des cordes en même temps que le casque, et au-delà de ~20 ms cela produit un slapback perceptible entre les deux sources — effet absent en studio, marginal sur une électrique non amplifiée, mais réel.

### Matériel d'entrée dégradé

Un câble guitare-vers-USB (type Guitar Link, 20-30 €) **est** une interface class-compliant : il marche sans pilote et il est pleinement supporté. Un jack vers mini-jack dans l'entrée micro du portable est autre chose : un micro passif veut une charge de 500 kΩ à 1 MΩ, l'entrée micro en offre quelques kΩ et injecte une tension de polarisation prévue pour un électret. Résultat : niveau faible, aigus mangés, son fin — plus 40 ms et davantage sur l'audio onboard.

L'utilisateur ne peut pas distinguer un problème d'impédance d'un mauvais moteur DSP : il entendra « Tonecraft sonne fin et en retard ». C'est détectable à la calibration (label du périphérique, latence mesurée, niveau d'entrée, bande passante). **Dire la cause et le remède en une phrase chacun, ne jamais bloquer l'accès.**

---

## 4. Règles frontend

- Les pages de contenu envoient **0 kB de JS**. Toute hydratation doit être justifiée.
- L'application est **un seul îlot**, sur une seule route, en `client:only="svelte"`.
- **Aucun contrôle rotatif. Tous les contrôles continus sont des faders verticaux linéaires**, en SVG + `transform: translate()` en CSS. Jamais de canvas, jamais de sprite sheet. Composité GPU, coût CPU nul. Voir `DESIGN.md` §1 et §6 : c'est une position argumentée, pas une préférence.
- **Aucun `<canvas>`, aucun `AnalyserNode`, ni spectre ni oscilloscope.** Toute la visualisation est portée par le cordon (`DESIGN.md` §5) : un filet SVG/CSS dont l'opacité par segment est pilotée par le RMS de chaque étage, calculé dans le worklet et posté à 30 Hz. Suspendu quand l'onglet est caché.
- Sur les pages preset pré-rendues, le cordon est alimenté par l'enveloppe RMS calculée au build et livrée en JSON, animée depuis `audio.currentTime`. Aucun graphe audio, même signature visuelle sur les deux chemins.
- Interdits en animation : `backdrop-filter`, `filter: blur()`, `box-shadow` animée. Uniquement `transform` et `opacity`.
- Polices self-hostées, woff2, sous-ensemblées, `font-display: swap`. Aucun appel à Google Fonts.
- Le thread principal ne doit jamais bloquer plus de 8 ms : un jank UI se traduit par un dropout audible.

---

## 5. Direction artistique

**`DESIGN.md` est la source de vérité.** Cette section n'en est que le rappel ; en cas d'écart, `DESIGN.md` gagne.

Direction : **nylon et minéral**. Les références ne sont pas du matériel de guitare — ce sont la photographie de maquettes d'architecture, les panneaux d'instruments Braun, et la face mate d'une céramique non émaillée. Aucune référence à un plugin existant ni à un artiste : `PRODUCT.md` §7 l'interdit explicitement, et s'en réclamer dans le dépôt finirait par se voir dans le produit.

- Minimalisme flat assumé. Aucun skeuomorphisme, aucune texture de tolex, aucun reflet chromé.
- Palette de six tokens. Fond **gris-vert froid** `--chalk #E7E8E2`, délibérément pas un crème chaud : le crème est l'endroit où tous les outils audio « doux » ont atterri ces deux dernières années, et il rend générique dès qu'on est à côté d'un concurrent. Une seule couleur d'accent, `--celadon`.
- Typographie fine, généreusement espacée. Beaucoup d'espace négatif.
- **Aucun knob rond nulle part.** Tous les contrôles continus sont des faders verticaux linéaires à filet fin et cap plat. C'est un écart assumé avec la convention de la catégorie : une rangée de faders se lit d'un coup d'œil, se manipule au doigt comme à la souris, et se lit instantanément comme du logiciel plutôt que comme une photo de matériel.
- Hiérarchie par l'espacement et le poids typographique, pas par des bordures ou des cadres.

Tous les tokens (couleurs, espacements, rayons, durées) sont centralisés en custom properties CSS. Aucune valeur en dur dans les composants.

---

## 6. SEO

L'app elle-même ne rankera jamais. Le trafic vient du contenu satellite, statique, généré au build.

- **Une URL indexable par preset** (`/presets/<slug>`), avec JSON-LD. Ces pages ne décrivent pas un son : **elles le font entendre**, via le fichier rendu au build, en une seconde et sans une ligne de JS. Le contenu satellite cesse d'être un satellite, c'est le produit pour la majorité des visiteurs.
- **Une URL par ampli et par pédale modélisés** — mais la v1 ne ship qu'un seul ampli et **un seul preset**. Il n'y a donc qu'une page preset au lancement : la surface indexable vient des **guides longue traîne**, qui passent de contenu satellite à livrable de lancement. Chaque preset et chaque ampli ajoutés ensuite deviennent une page — une cadence éditoriale, pas un prérequis.
- Guides longue traîne, en priorité : jouer de la guitare sur PC sans interface audio, réduire la latence sans ASIO, ampli guitare gratuit dans le navigateur.
- **i18n FR/EN dès le premier jour.** Le marché anglophone est un ordre de grandeur au-dessus. `hreflang` correct sur chaque page.
- JSON-LD obligatoire : `SoftwareApplication` sur la home, `FAQPage` sur le FAQ, `HowTo` sur les guides.
- Sitemap et OG images générées au build (`@astrojs/sitemap`, Satori).
- Presets partageables par hash d'URL, aucun état utilisateur côté serveur.

Objectif Core Web Vitals : 100/100. C'est atteignable sans effort en Astro statique et c'est un avantage concurrentiel réel face aux sites de plugins.

---

## 7. Compatibilité

La latence étant secondaire, les statuts de compatibilité changent : Firefox n'était « dégradé » et Safari « best effort » que sur ce critère.

| Navigateur | Chemin écouter | Chemin jouer |
|---|---|---|
| Chrome / Edge desktop | Supporté | Supporté, latence optimale |
| Firefox desktop | Supporté | Supporté, pas de `setSinkId` |
| Safari desktop | Supporté | Supporté, latence supérieure |
| Mobile | **Supporté** | Non supporté, message d'explication |

Le chemin écouter n'a aucune exigence : ni WASM, ni `AudioContext`, ni permission. Il marche partout, téléphones compris — ce qui réconcilie l'ancienne exclusion du mobile avec la promesse d'un mode démo consultable sur téléphone.

Un écran d'onboarding détecte le navigateur, le périphérique, la fréquence d'échantillonnage, diagnostique une entrée micro onboard, et guide l'utilisateur avant tout chargement du moteur audio. Il ne bloque jamais.

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
