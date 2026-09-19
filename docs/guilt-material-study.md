# GUILT — étude de matière

Références locales fournies : `/home/shinkei/Pictures/1.png`, `2.png`, `3.jpg`, `4.jpg`.

- **1** : cadre arrondi épais, façade en retrait, élément central concentrique saillant, commandes claires avec ombres portées.
- **2** : pièces assemblées, poignée rigide, raccords de panneaux et éclairage intérieur qui souligne la profondeur.
- **3** : vue de trois quarts révélant l'épaisseur du flanc, les biseaux, la hauteur des boutons et les pieds métalliques.
- **4** : ornement sculpté sous lumière rasante, moulures successives et contraste entre décor complexe et commandes sobres.

Adaptation Tonecraft : studio sombre conservé, métal argenté patiné réservé à la tête GUILT, rosace/ogives/quatrefoils du vitrail original, verre violet et bordeaux. Les paramètres et la chaîne audio ne changent pas.

La façade est un rendu statique. Les masques SVG isolent les zones colorées pour que l'extinction du verre ne fasse pas disparaître les reflets du métal. Seules les opacités suivent le signal. Le châssis et les commandes sont construits en CSS ; aucun moteur 3D au runtime. Vue centrée, prise d'un peu au-dessus : le dessus du caisson se voit, jamais les flancs ; poignée posée dessus, pieds et rangée de potentiomètres symétriques, faces des boutons concentriques. Le caisson porte le métal du vitrail, à la même valeur, pour que les deux ne se lisent pas comme deux matières. GUILT et LUX EX SONO apparaissent directement sur le vitrail, sans plaque.

Asset : `public/images/guilt-sculpted-glass.webp`. Généré avec l'outil intégré **imagegen**, puis encodé en WebP. L'image originale est conservée. Prompt complet : `guilt-material-prompt.txt`.

Vérification : compilation de production réussie dans une copie isolée ; Svelte sans erreur (un avertissement existant dans TabReader). Contrôles navigateur validés : clavier, glisser, retour au preset, activation des groupes, alimentation, réduction des animations, absence de débordement horizontal sur sept formats de 360 à 1920 px. Accueil français vérifié avec les nouvelles captures. La suite globale `test:studio` s'arrête sur son assertion de centrage du curseur de tablature (écart de 54 px, ligne 420) ; elle n'est donc pas entièrement validée. Le lecteur de tablature n'a pas été modifié dans cette intervention.
