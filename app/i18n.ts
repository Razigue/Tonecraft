/**
 * French and English (FR-41), in the one island on the one route: the language
 * is detected, not asked for, and changed only from the settings sheet. What is here is what a visitor reads
 * before they have touched anything — the welcome and the tutorial. The rig's
 * own labels are the names printed on its panel and read the same in both.
 *
 * The choice is kept on this device, in localStorage: two letters read
 * synchronously before the first paint, so the page never flashes in the other
 * language. Before a choice is made, the browser's own languages decide.
 */

export type Locale = 'en' | 'fr';
export const LOCALES: readonly Locale[] = ['en', 'fr'];
const KEY = 'tonecraft-locale';

export function detectLocale(): Locale {
  // The French home page links here with ?lang=fr: someone who read the page in
  // one language expects the studio in it. Kept as their choice from then on.
  const asked = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('lang');
  if (asked === 'en' || asked === 'fr') {
    saveLocale(asked);
    // Out of the address once kept, so a copied tone link does not carry it.
    const url = new URL(location.href);
    url.searchParams.delete('lang');
    history.replaceState(history.state, '', url);
    return asked;
  }
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'fr') return saved;
  } catch { /* storage blocked: fall through to the browser's language */ }
  const languages = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language];
  return languages.some((l) => l.toLowerCase().startsWith('fr')) ? 'fr' : 'en';
}

export function saveLocale(locale: Locale): void {
  try { localStorage.setItem(KEY, locale); } catch { /* the choice lasts this visit only */ }
}

/**
 * A tutorial step. In the paragraphs, `[words](term)` is a defined term: bold,
 * and hovering it rings what it names (the terms are mapped to the page in
 * Rig.svelte). `**words**` is bold alone.
 */
export interface TourText {
  readonly title: string;
  readonly body: readonly string[];
  /** Something to do on the page before the next step, which waits for it. */
  readonly task?: string;
}

export interface Messages {
  readonly language: string;
  /** The settings sheet: the language for everyone, the audio for a musician. */
  readonly settings: string;
  readonly welcome: {
    readonly title: string;
    readonly lede: string;
    readonly musicianAction: string;
    readonly testerAction: string;
    readonly musician: string;
    readonly musicianBody: string;
    readonly tester: string;
    readonly testerBody: string;
    readonly explore: string;
  };
  readonly tour: {
    readonly open: string;
    readonly skip: string;
    readonly back: string;
    readonly next: string;
    readonly done: string;
    /** The tutorial folded out of the way on a small screen, and back. */
    readonly collapse: string;
    readonly expand: string;
    /** In the order of the windows the tutorial lights. */
    readonly steps: readonly [TourText, TourText, TourText, TourText, TourText, TourText, TourText];
  };
}

export const MESSAGES: Readonly<Record<Locale, Messages>> = {
  en: {
    language: 'Language',
    settings: 'Settings',
    welcome: {
      lede: 'Two ways in. The rig is the same.',
      musicianAction: 'Plug in',
      testerAction: 'Listen',
      title: 'Welcome to Tonecraft',
      musician: 'Musician',
      musicianBody: 'Plug in your guitar and choose your audio input.',
      tester: 'Tester',
      testerBody: 'Explore the sounds with a demo, with no guitar and no microphone access.',
      explore: 'Explore first',
    },
    tour: {
      open: 'Tutorial',
      skip: 'Skip the tutorial',
      back: 'Back',
      next: 'Next',
      done: 'Done',
      collapse: 'Fold the tutorial',
      expand: 'Unfold the tutorial',
      steps: [
        {
          title: 'General settings',
          body: [
            '[Input](input) sets the **input gain**: how strong your guitar’s signal is when it enters the chain. The meter beside it shows what comes in.',
            '[Gate](gate) removes the hiss you hear between the notes you play. The higher it is set, the sooner it cuts; the light beside its name turns it on or off.',
            '[Tone preset](preset) loads a complete sound in one go: the [amp](amp), the [cabinet](cab) and all of their settings. The ‹ and › arrows move from one preset to the next.',
            '[Output](output) sets the final volume, the one you hear in your headphones.',
          ],
        },
        {
          title: 'The amp',
          body: [
            '[Tone](tone) shapes the sound: bass, mids, treble and presence.',
            '[Pitch](pitch) transposes: the guitar sounds lower or higher than its real tuning, without touching the strings. Shift sets the interval in semitones, Mix blends in the transposed sound.',
            '[Boost](boost) drives the amp harder for more saturation; its Color sets the brightness.',
            '[Reverb](reverb) adds echo, as if you were playing in a large room. Mix sets how much.',
            'Click a [block’s name](blocks) to switch it on or off. [Power](power) turns the whole chain off, to hear the dry guitar.',
          ],
        },
        {
          title: 'The demo',
          body: [
            '[Listen to a demo](demo) plays a guitar recorded without any effect, sent live through the amp.',
            'Turn a knob while it plays and you hear the change at once: the best way to understand what each setting does.',
            'Once the demo is open, click the [waveform](wave) to move through it, and tick [Loop](loop) to hear it on repeat.',
          ],
        },
        {
          title: 'The tab reader',
          body: [
            '[Import tab](import) opens a Guitar Pro, MusicXML, Capella or alphaTex file, or drop one right here. The tab scrolls as it plays, performed by real instruments.',
            'Each track has its own controls: [Solo](solo) isolates its audio so you hear it alone, [Mute](mute) silences it, and its [slider](volume) sets its volume.',
            'Under the tab, the [neck](neck) shows where to put your fingers, and [Scale](scale) can lay a scale over it.',
          ],
        },
        {
          title: 'Write your own tab',
          body: [
            '[Write a tab](write) opens an empty tab to compose your own.',
            'Start by choosing the [tempo](tempo), the [time signature](signature) (4/4, 3/4, 6/8…) and the [tuning](tuning), as well as the number of strings.',
            'Write notes with the [number keys](digits) on your keyboard, on the numeric keypad or the row above the letters: type 1 then 2 for fret 12. You can also click a fret on the [neck](neck).',
            'Move through the beats of the bar with the [arrow keys](arrows) ← and →, and change string with ↑ and ↓. Several notes on the same beat make a chord. **Delete** erases the note, **Backspace** the whole beat.',
            '**+** and **−** make a note shorter or longer, **Space** plays back what you have written, and **Export .gp** saves it as a Guitar Pro file.',
          ],
          task: 'Your turn: click **Write a tab**, then type a number on your keyboard or tap a fret on the neck. You will hear the note as it is written.',
        },
        {
          title: 'The metronome',
          body: [
            'The [metronome](metronome) opens here: set a tempo, or tap it in time.',
            'The [play button](metronomePlay) beside it starts and stops it. Opening a tab sets it to the tab’s tempo automatically.',
          ],
        },
        {
          title: 'Your turn',
          body: [
            'Got a guitar at hand? Reload the page and choose **Musician**: you will play through the same chain, with the tuner, the looper and the recorder as well.',
            'You can start this tutorial again at any time with the [Tutorial](tutorial) button at the top of the page.',
          ],
        },
      ],
    },
  },
  fr: {
    language: 'Langue',
    settings: 'Réglages',
    welcome: {
      lede: 'Deux entrées. Le même ampli.',
      musicianAction: 'Brancher',
      testerAction: 'Écouter',
      title: 'Bienvenue sur Tonecraft',
      musician: 'Musicien',
      musicianBody: 'Branchez votre guitare et sélectionnez votre entrée audio.',
      tester: 'Testeur',
      testerBody: 'Explorez les sons avec une démo, sans guitare ni accès au micro.',
      explore: 'Explorer d’abord',
    },
    tour: {
      open: 'Tutoriel',
      skip: 'Passer le tutoriel',
      back: 'Précédent',
      next: 'Suivant',
      done: 'Terminer',
      collapse: 'Replier le tutoriel',
      expand: 'Déplier le tutoriel',
      steps: [
        {
          title: 'Réglages généraux',
          body: [
            '[Entrée](input) règle le **gain d’entrée**, c’est-à-dire l’intensité du signal de votre guitare à son arrivée dans la chaîne. Le vumètre à côté montre ce qui entre.',
            '[Gate](gate) supprime le souffle qu’on entend entre les notes jouées. Plus il est haut, plus il coupe tôt ; le voyant à côté de son nom l’active ou le désactive.',
            '[Preset de son](preset) charge un son complet en un seul geste : l’[ampli](amp), le [baffle](cab) et tous leurs réglages. Les flèches ‹ et › passent d’un preset à l’autre.',
            '[Sortie](output) règle le volume final, celui que vous entendez au casque.',
          ],
        },
        {
          title: 'L’ampli',
          body: [
            '[Timbre](tone) façonne le timbre : graves, médiums, aigus et présence.',
            '[Hauteur](pitch) transpose : la guitare sonne plus grave ou plus aiguë que son accordage réel, sans toucher aux cordes. Transpo règle l’écart en demi-tons, Mix dose le son transposé.',
            '[Boost](boost) pousse l’ampli plus fort pour obtenir davantage de saturation ; son réglage Couleur règle la brillance.',
            '[Réverb](reverb) ajoute de l’écho, comme si vous jouiez dans une grande pièce. Mix règle la quantité d’écho.',
            'Cliquez sur le [nom d’un bloc](blocks) pour l’allumer ou l’éteindre. [Marche](power) coupe toute la chaîne pour entendre la guitare brute.',
          ],
        },
        {
          title: 'La démo',
          body: [
            '[Écouter une démo](demo) lance une guitare enregistrée sans aucun effet, qui passe en direct dans l’ampli.',
            'Tournez un bouton pendant la lecture : le changement s’entend immédiatement. C’est la meilleure façon de comprendre ce que fait chaque réglage.',
            'Une fois la démo ouverte, cliquez sur la [forme d’onde](wave) pour vous déplacer, et cochez [En boucle](loop) pour l’écouter en boucle.',
          ],
        },
        {
          title: 'Le lecteur de tablatures',
          body: [
            '[Importer une tab](import) ouvre une tablature Guitar Pro, MusicXML, Capella ou alphaTex ; vous pouvez aussi la glisser directement ici. Elle défile pendant la lecture, jouée par de vrais instruments.',
            'Chaque piste se règle séparément : [Solo](solo) isole son audio pour l’entendre seule, [Muet](mute) la coupe, et son [curseur](volume) règle son volume.',
            'Sous la tablature, le [manche](neck) montre où poser les doigts, et [Gamme](scale) peut y afficher une gamme.',
          ],
        },
        {
          title: 'Écrire sa tablature',
          body: [
            '[Écrire une tab](write) ouvre une tablature vide pour composer la vôtre.',
            'Choisissez d’abord le [tempo](tempo), la [signature rythmique](signature) (4/4, 3/4, 6/8…) et l’[accordage](tuning), ainsi que le nombre de cordes.',
            'Écrivez les notes avec les [chiffres](digits) de votre clavier, sur le pavé numérique ou la rangée au-dessus des lettres : tapez 1 puis 2 pour la case 12. Vous pouvez aussi cliquer une case sur le [manche](neck).',
            'Parcourez les temps de la mesure avec les [flèches](arrows) ← et →, et changez de corde avec ↑ et ↓. Plusieurs notes sur un même temps forment un accord. **Suppr** efface la note, **Retour arrière** le temps entier.',
            '**+** et **−** raccourcissent ou allongent la note, **Espace** fait écouter ce que vous avez écrit, et **Export .gp** l’enregistre au format Guitar Pro.',
          ],
          task: 'À vous : cliquez sur **Écrire une tab**, puis tapez un chiffre au clavier ou touchez une case du manche. Vous entendrez la note au moment où elle s’écrit.',
        },
        {
          title: 'Le métronome',
          body: [
            'Le [métronome](metronome) s’ouvre ici : réglez un tempo, ou tapez-le en rythme.',
            'Le [bouton lecture](metronomePlay) à côté le lance et l’arrête. Ouvrir une tablature le cale automatiquement sur son tempo.',
          ],
        },
        {
          title: 'À vous de jouer',
          body: [
            'Vous avez une guitare sous la main ? Rechargez la page et choisissez **Musicien** : vous jouerez à travers la même chaîne, avec en plus l’accordeur, le looper et l’enregistreur.',
            'Vous pouvez relancer ce tutoriel à tout moment avec le bouton [Tutoriel](tutorial), en haut de la page.',
          ],
        },
      ],
    },
  },
};
