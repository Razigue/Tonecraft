# GUILT — étude de matière

Références locales fournies : `/home/shinkei/Pictures/1.png`, `2.png`, `3.jpg`, `4.jpg`.

- **1** : cadre arrondi épais, façade en retrait, élément central concentrique saillant, commandes claires avec ombres portées.
- **2** : pièces assemblées, poignée rigide, raccords de panneaux et éclairage intérieur qui souligne la profondeur.
- **3** : vue de trois quarts révélant l'épaisseur du flanc, les biseaux, la hauteur des boutons et les pieds métalliques.
- **4** : ornement sculpté sous lumière rasante, moulures successives et contraste entre décor complexe et commandes sobres.

Adaptation Tonecraft : studio sombre conservé, métal argenté patiné réservé à la tête GUILT, rosace/ogives/quatrefoils du vitrail original, verre violet et bordeaux. Les paramètres et la chaîne audio ne changent pas.

La façade est un rendu statique. Les masques SVG isolent les zones colorées pour que l'extinction du verre ne fasse pas disparaître les reflets du métal. Seules les opacités suivent le signal. Le châssis et les commandes sont construits en CSS ; aucun moteur 3D au runtime. Vue centrée, prise d'un peu au-dessus : le dessus du caisson se voit, jamais les flancs ; poignée posée dessus, pieds et rangée de potentiomètres symétriques, faces des boutons concentriques. Le caisson porte le métal du vitrail, à la même valeur, pour que les deux ne se lisent pas comme deux matières. GUILT et LUX EX SONO apparaissent directement sur le vitrail, sans plaque.

Asset : `public/images/guilt-sculpted-glass.webp`. Généré avec l'outil intégré **imagegen**, puis encodé en WebP. L'image originale est conservée. Prompt complet : `guilt-material-prompt.txt`.

Harmonisation corrigée : le caisson et la bande de commandes reprennent uniquement la matière du cadre argenté du vitrail. Les aplats sont plus sombres, les arêtes polies plus contrastées, et la moulure extérieure reste simple. Aucun motif du vitrail n'est reproduit ailleurs : façade en émail violet, bordures ornementales et incrustation de la poignée retirées ; faces argentées des boutons rétablies. La finition repose sur les dégradés CSS et le grain de métal existant. Dimensions, positions, perspective, pieds et axes des boutons conservés. Vitrail principal et éclairage inchangés.

Commandes : les références 1 et 2 inspirent les biseaux larges, les centres légèrement creusés et les ombres de contact. Les potentiomètres reprennent l'argent patiné du cadre : jupe finement cannelée, biseau poli, repère sombre gravé ; leur éclairage reste fixe pendant la rotation du repère. L'interrupteur est en métal patiné, avec un petit voyant violet. Emplacements, dimensions extérieures, axes, interactions et perspective conservés.

Vérification de l'harmonisation : Svelte sans erreur (un avertissement existant dans TabReader). Contrôles navigateur validés : clavier, glisser, double-clic de réinitialisation, activation des groupes, alimentation, réduction des animations et absence d'erreur JavaScript. Aucun débordement horizontal sur sept formats de 360 à 1920 px ; commandes centrées. Comparaison avec la version de départ : règles du dessus du caisson, de la poignée, des pieds et de l'encadrement du vitrail inchangées. Captures du studio, de l'ampli et de sa bande de commandes actualisées.

Compilation de production de l'harmonisation réussie, nouvelles captures incluses.

Vérification antérieure du vitrail : compilation de production réussie dans une copie isolée et accueil français vérifié. La suite globale `test:studio` s'arrêtait sur son assertion de centrage du curseur de tablature (écart de 54 px, ligne 420). Cette suite n'a pas été relancée pour l'harmonisation des matières ; le lecteur de tablature n'a pas été modifié.
