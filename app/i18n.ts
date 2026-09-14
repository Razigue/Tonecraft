/**
 * French and English (FR-41), in the one island on the one route: the language
 * is chosen on the page, not by URL. What is here is what a visitor reads
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

export interface TourText { readonly title: string; readonly body: readonly string[] }

export interface Messages {
  readonly language: string;
  readonly welcome: {
    readonly title: string;
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
    /** In the order of the windows the tutorial lights. */
    readonly steps: readonly [TourText, TourText, TourText, TourText, TourText, TourText, TourText];
  };
}

export const MESSAGES: Readonly<Record<Locale, Messages>> = {
  en: {
    language: 'Language',
    welcome: {
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
      steps: [
        {
          title: 'Input, amp and preset',
          body: [
            'Input sets how hard the guitar hits the chain; its meter shows what arrives. Gate silences the hiss between notes.',
            'Amplifier picks the captured amp, Cabinet the speaker cabinet after it.',
            'Tone preset recalls a complete sound at once, and ‹ and › step to the next one. Output sets the final volume.',
          ],
        },
        {
          title: 'The amp',
          body: [
            'Tone: bass, mids, treble and presence. Pitch transposes the guitar. Boost pushes the amp for more saturation. Reverb adds the space of a room.',
            'Click a block’s name to switch it on or off. Power turns the whole chain off, to hear the dry guitar.',
          ],
        },
        {
          title: 'The demo',
          body: [
            'A guitar recorded without effects, played live through the amp: every setting you touch is heard at once.',
            'Click the waveform to move through it, and Loop to repeat it.',
          ],
        },
        {
          title: 'The tab reader',
          body: [
            'Import or drop a Guitar Pro, MusicXML, Capella or alphaTex file: the tab scrolls and plays with its own instruments.',
            'Each track has its own solo, mute and volume; the neck shows the notes being played, and a scale can be laid over it.',
          ],
        },
        {
          title: 'Compose your own tabs',
          body: [
            'Write a tab turns the reader into an editor: compose from an empty tab in 4/4, and press Space at any moment to hear what you have written.',
            'Write frets with the numeric keypad or the number keys above the letters: 1 then 2 is fret 12.',
            'Move with the arrows: ← and → go from beat to beat, ↑ and ↓ from string to string. Several frets on the same beat make a chord, and the neck shows all of it.',
            'Pick durations from the bar or with + and −, a dot with ., a rest with R. Set the tempo, the number of strings and the tuning, add or delete tracks, then export it to Guitar Pro.',
          ],
        },
        {
          title: 'The metronome',
          body: [
            'Open it to set a tempo, or tap one in; the play button beside it starts and stops it.',
            'Opening a tab sets it to the tab’s tempo.',
          ],
        },
        {
          title: 'Your turn',
          body: [
            'Got a guitar at hand? Reload the page and choose Musician: you will play through the same chain, with the tuner, the looper and the recorder.',
            'Start this tutorial again from the Tutorial button at the top of the page.',
          ],
        },
      ],
    },
  },
  fr: {
    language: 'Langue',
    welcome: {
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
      steps: [
        {
          title: 'Entrée, ampli et preset',
          body: [
            'Input règle le niveau de la guitare à l’entrée de la chaîne ; son vumètre montre ce qui arrive. Gate coupe le souffle entre les notes.',
            'Amplifier choisit l’ampli capturé, Cabinet le baffle qui le suit.',
            'Tone preset rappelle un son complet d’un coup, ‹ et › passent au suivant. Output règle le volume final.',
          ],
        },
        {
          title: 'L’ampli',
          body: [
            'Tone : graves, médiums, aigus et présence. Pitch transpose la guitare. Boost pousse l’ampli pour plus de saturation. Reverb ajoute l’espace d’une pièce.',
            'Cliquer le nom d’un bloc l’allume ou l’éteint. Power coupe toute la chaîne pour entendre la guitare brute.',
          ],
        },
        {
          title: 'La démo',
          body: [
            'Une guitare enregistrée sans effet, jouée en direct à travers l’ampli : chaque réglage touché s’entend aussitôt.',
            'Cliquez la forme d’onde pour vous y déplacer, Loop pour la répéter.',
          ],
        },
        {
          title: 'Le lecteur de tablatures',
          body: [
            'Importez ou déposez un fichier Guitar Pro, MusicXML, Capella ou alphaTex : la tablature défile et se joue avec ses propres instruments.',
            'Chaque piste a son solo, son mute et son volume ; le manche montre les notes jouées, et une gamme peut s’y superposer.',
          ],
        },
        {
          title: 'Composez vos tablatures',
          body: [
            'Write a tab transforme le lecteur en éditeur : composez à partir d’une tablature vide en 4/4, et appuyez sur Espace à tout moment pour entendre ce que vous avez écrit.',
            'Écrivez les cases avec le pavé numérique ou les chiffres au-dessus des lettres : 1 puis 2 donne la case 12.',
            'Naviguez avec les flèches : ← et → passent d’un temps à l’autre, ↑ et ↓ d’une corde à l’autre. Plusieurs cases sur le même temps forment un accord, et le manche l’affiche en entier.',
            'Choisissez les durées dans la barre ou avec + et −, un point avec ., un silence avec R. Réglez le tempo, le nombre de cordes et l’accordage, ajoutez ou supprimez des pistes, puis exportez en Guitar Pro.',
          ],
        },
        {
          title: 'Le métronome',
          body: [
            'Ouvrez-le pour régler un tempo, ou tapez-le au rythme voulu ; le bouton lecture à côté le lance et l’arrête.',
            'Ouvrir une tablature le cale sur son tempo.',
          ],
        },
        {
          title: 'À vous de jouer',
          body: [
            'Une guitare sous la main ? Rechargez la page et choisissez Musicien : vous jouerez à travers la même chaîne, avec l’accordeur, le looper et l’enregistreur.',
            'Ce tutoriel se relance depuis le bouton Tutoriel, en haut de la page.',
          ],
        },
      ],
    },
  },
};
