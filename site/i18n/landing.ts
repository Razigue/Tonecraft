/**
 * The landing page copy, in both languages. One structure, two locales: the
 * page is written once in `site/components/Landing.astro` and the build emits
 * `/` and `/fr/` from it, each a complete static document a crawler reads
 * without running anything.
 *
 * The story is the cover: Tonecraft is every tool a guitar cover needs, in one
 * place, played through ASIO at the interface's lowest latency. DESIGN.md §9
 * applies: plain, short, never enthusiastic, no real gear names.
 */

export type LandingLocale = 'en' | 'fr';

export interface Feature {
  /** Anchor and image key. */
  readonly id: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly body: readonly string[];
  /** Short term / explanation pairs printed under the body. */
  readonly points?: readonly (readonly [string, string])[];
}

export interface LandingCopy {
  readonly htmlLang: string;
  readonly ogLocale: string;
  readonly title: string;
  readonly description: string;
  readonly nav: { readonly features: string; readonly engine: string; readonly faq: string; readonly open: string; readonly language: string };
  readonly hero: { readonly tagline: string; readonly lede: string; readonly price: string; readonly open: string; readonly more: string; readonly facts: readonly string[] };
  readonly overview: { readonly eyebrow: string; readonly title: string; readonly body: readonly string[]; readonly steps: readonly (readonly [string, string])[] };
  readonly engine: Feature;
  readonly features: readonly Feature[];
  readonly pair: readonly [Feature, Feature];
  readonly banner: { readonly line: string; readonly sub: string };
  readonly requirements: { readonly title: string; readonly items: readonly string[]; readonly browsers: string; readonly table: readonly (readonly [string, string, string])[]; readonly head: readonly [string, string, string] };
  readonly faq: { readonly title: string; readonly items: readonly (readonly [string, string])[] };
  readonly cta: { readonly title: string; readonly body: string; readonly open: string };
  readonly footer: { readonly tagline: string; readonly product: string; readonly source: string; readonly license: string };
  readonly alt: Record<string, string>;
}

const en: LandingCopy = {
  htmlLang: 'en',
  ogLocale: 'en_US',
  title: 'Tonecraft | The all-in-one toolbox for guitar covers',
  description:
    'Open the tab, load the song, dial the tone, record your cover. Amp, tab reader, backing track, recorder, looper, tuner and metronome in one free app, played through ASIO at minimal latency.',
  nav: { features: 'Toolbox', engine: 'ASIO', faq: 'FAQ', open: 'Open the studio', language: 'Language' },
  hero: {
    tagline: 'Everything a guitar cover needs, in one place.',
    lede: 'The tab, the song, the tone and the take, played through ASIO at your interface’s lowest latency. No plugin, no DAW, no account.',
    price: 'Free',
    open: 'Open the studio',
    more: 'See the toolbox',
    facts: ['ASIO · CoreAudio · ALSA', 'Windows · macOS · Linux'],
  },
  overview: {
    eyebrow: 'Overview',
    title: 'From the first bar to the finished cover.',
    body: [
      'A cover takes five tools: something to read the part, the song to play over, a tone that fits it, a way to work the hard bars, and a recorder. Tonecraft is all five, on one screen, on one clock.',
      'Your settings stay on your computer. A tone is shared as a link.',
    ],
    steps: [
      ['Read', 'open the tab, the band plays along'],
      ['Sound', 'pick the amp, the cabinet, the boost'],
      ['Practise', 'slow down, loop the solo'],
      ['Record', 'play over the song, export a WAV'],
    ],
  },
  engine: {
    id: 'engine',
    eyebrow: 'Tonecraft Engine · ASIO',
    title: 'ASIO. Minimal latency.',
    body: [
      'Tonecraft Engine opens your interface’s ASIO driver and runs the chain at its lowest buffer: the note leaves the amp as the pick leaves the string. A small free program by the clock, offered from the studio’s audio settings. Everything is still set in Tonecraft.',
      'The same chain, bit for bit, as in the browser, which stays available on a computer where nothing can be installed.',
    ],
  },
  features: [
    {
      id: 'tabs',
      eyebrow: 'Tab reader',
      title: 'Open the tab. The band plays along.',
      body: [
        'Guitar Pro, MusicXML and more open right in the page. The score scrolls under a fixed playhead, the neck below lights the notes, and the band plays with you: slowed down, looped on the hard bars, or with your part muted.',
        'Write your own tabs too: type a fret, hear the note.',
      ],
    },
    {
      id: 'session',
      eyebrow: 'Backing track · Recorder · Looper',
      title: 'Play over the song. Keep the take.',
      body: [
        'Drop the song in as a backing track and record your part over it. The recorder keeps the dry guitar, so a take can be exported tomorrow through another tone, aligned to the sample with the song.',
        'The looper records what you hear and plays it back under you, to work a riff until it holds.',
      ],
    },
    {
      id: 'amp',
      eyebrow: 'Amplifier',
      title: 'GUILT, and a shelf of captures',
      body: [
        'The lead amplifier is a neural capture of a real high-gain head. Four community captures of high-gain heads sit next to it.',
      ],
      points: [
        ['Metal', 'tight, fast, articulate'],
      ],
    },
    {
      id: 'pedals',
      eyebrow: 'Around the amp',
      title: 'Gate, boost, tone, pitch, reverb',
      body: ['A short chain in a fixed order, tuned so that the first sound is already the right one.'],
      points: [
        ['Gate', 'silence between notes'],
        ['Boost', 'a tighter low end'],
        ['Pitch', 'drop tuning, no pegs'],
        ['Reverb', 'room for the lead'],
      ],
    },
    {
      id: 'cab',
      eyebrow: 'Cabinet',
      title: 'Cabinets, or your own IR',
      body: [
        'Each capture comes with a cabinet. Load any impulse response from your disk to replace it: WAV, AIFF or FLAC, convolved inside the chain with zero added latency.',
      ],
    },
  ],
  pair: [
    {
      id: 'tuner',
      eyebrow: 'Tuner',
      title: 'Tuner',
      body: ['Chromatic, to the cent, unaffected by latency. Tune to the song before the first take.'],
    },
    {
      id: 'metronome',
      eyebrow: 'Metronome',
      title: 'Metronome',
      body: ['Tempo, time signature, tap. The click is never printed into a loop or a take.'],
    },
  ],
  banner: { line: 'Plug in. Cover it.', sub: 'The tab, the song, the tone. Your take.' },
  requirements: {
    title: 'System requirements',
    items: [
      'A desktop or laptop computer running Windows, macOS or Linux.',
      'An audio interface, with an ASIO driver for ASIO. A guitar-to-USB cable works too.',
      'Headphones or monitors, plugged into the interface.',
      'Tonecraft Engine for ASIO on Windows, CoreAudio on macOS, ALSA on Linux. Without it, Tonecraft plays in the browser.',
    ],
    browsers: 'Browsers',
    head: ['Browser', 'Tonecraft Engine', 'Browser only'],
    table: [
      ['Chrome / Edge', 'Yes', 'Yes'],
      ['Firefox', 'Yes', 'Yes, default output'],
      ['Safari', 'No', 'Yes, higher latency'],
      ['Mobile', 'No', 'No'],
    ],
  },
  faq: {
    title: 'Questions',
    items: [
      ['What do I need to record a guitar cover?', 'A guitar, an interface and Tonecraft. The tab reader, the backing track, the amp and the recorder are on the same page, and the export is a WAV.'],
      ['How low is the latency?', 'With Tonecraft Engine and ASIO, as low as your interface allows. In the browser alone it depends on the system. The round trip is measured and always on screen.'],
      ['Is Tonecraft free?', 'Yes. No account, no subscription, no trial.'],
      ['Which tab formats can I open?', 'Guitar Pro 3 to 7, GPX, MusicXML, Capella and alphaTex. Files are read on your computer, never uploaded.'],
      ['Do I need to install anything?', 'Only Tonecraft Engine, for ASIO, offered in the studio’s audio settings. Everything else is in Tonecraft.'],
      ['Is my sound sent anywhere?', 'No. Audio is processed on your computer and never leaves it.'],
      ['Can I share a tone?', 'Yes. A tone is a link: whoever opens it hears the same settings.'],
    ],
  },
  cta: { title: 'Your next cover starts here.', body: 'Open the studio, plug in, load the tab.', open: 'Open the studio' },
  footer: { tagline: 'The all-in-one toolbox for guitar covers.', product: 'Product', source: 'Source code', license: 'Tonecraft Engine is GPL-3.0.' },
  alt: {
    hero: 'The GUILT amplifier head in Tonecraft, with its purple stained-glass window',
    overview: 'The Tonecraft studio: global controls, amplifier head and session tools',
    amp: 'The GUILT amplifier head and its control groups',
    pedals: 'The pitch, boost colour and reverb controls, in the chain band’s pedals panel',
    cab: 'Amplifier and cabinet selectors',
    session: 'Looper and recorder with a take waveform',
    tabs: 'A guitar tab scrolling above a lit fretboard',
    tuner: 'The chromatic tuner',
    metronome: 'The metronome',
    engine: 'Tonecraft audio settings with the ASIO choice',
    banner: 'The nave GUILT is photographed in',
  },
};

const fr: LandingCopy = {
  htmlLang: 'fr',
  ogLocale: 'fr_FR',
  title: 'Tonecraft | La boîte à outils tout-en-un pour vos covers guitare',
  description:
    'Ouvrez la tab, chargez le morceau, réglez le son, enregistrez votre cover. Ampli, lecteur de tablatures, piste de fond, enregistreur, looper, accordeur et métronome dans une seule app gratuite, en ASIO à latence minimale.',
  nav: { features: 'Boîte à outils', engine: 'ASIO', faq: 'FAQ', open: 'Ouvrir le studio', language: 'Langue' },
  hero: {
    tagline: 'Tout ce qu’il faut pour une cover guitare, au même endroit.',
    lede: 'La tab, le morceau, le son et la prise, joués en ASIO, à la latence la plus basse de votre interface. Ni plugin, ni DAW, ni compte.',
    price: 'Gratuit',
    open: 'Ouvrir le studio',
    more: 'Voir la boîte à outils',
    facts: ['ASIO · CoreAudio · ALSA', 'Windows · macOS · Linux'],
  },
  overview: {
    eyebrow: 'Présentation',
    title: 'De la première mesure à la cover terminée.',
    body: [
      'Une cover demande cinq outils : de quoi lire la partie, le morceau sur lequel jouer, un son qui colle, de quoi travailler les passages durs, et un enregistreur. Tonecraft réunit les cinq, sur un seul écran, sur une seule horloge.',
      'Vos réglages restent sur votre ordinateur. Un son se partage par un lien.',
    ],
    steps: [
      ['Lire', 'ouvrez la tab, le groupe joue avec vous'],
      ['Sonner', 'choisissez l’ampli, le baffle, le boost'],
      ['Travailler', 'ralentissez, bouclez le solo'],
      ['Enregistrer', 'jouez sur le morceau, exportez un WAV'],
    ],
  },
  engine: {
    id: 'engine',
    eyebrow: 'Tonecraft Engine · ASIO',
    title: 'ASIO. Latence minimale.',
    body: [
      'Tonecraft Engine ouvre le pilote ASIO de votre interface et fait tourner la chaîne à son plus petit buffer : la note sort de l’ampli quand le médiator quitte la corde. Un petit programme gratuit, près de l’horloge, proposé dans les réglages audio du studio. Tout se règle toujours dans Tonecraft.',
      'La même chaîne, au bit près, que dans le navigateur, qui reste disponible sur un ordinateur où rien ne peut être installé.',
    ],
  },
  features: [
    {
      id: 'tabs',
      eyebrow: 'Lecteur de tablatures',
      title: 'Ouvrez la tab. Le groupe joue avec vous.',
      body: [
        'Guitar Pro, MusicXML et d’autres s’ouvrent directement dans la page. La partition défile sous une tête de lecture fixe, le manche s’allume sous les notes, et le groupe joue avec vous : ralenti, en boucle sur les passages durs, ou sans votre partie.',
        'Écrivez aussi vos propres tabs : tapez une case, entendez la note.',
      ],
    },
    {
      id: 'session',
      eyebrow: 'Piste de fond · Enregistreur · Looper',
      title: 'Jouez sur le morceau. Gardez la prise.',
      body: [
        'Glissez le morceau en piste de fond et enregistrez votre partie dessus. L’enregistreur garde la guitare brute : la prise peut être exportée demain avec un autre son, alignée à l’échantillon sur le morceau.',
        'Le looper enregistre ce que vous entendez et le rejoue sous vos doigts, pour travailler un riff jusqu’à ce qu’il tienne.',
      ],
    },
    {
      id: 'amp',
      eyebrow: 'Ampli',
      title: 'GUILT, et une étagère de captures',
      body: [
        'L’ampli lead est une capture neuronale d’une vraie tête high gain. Quatre captures de têtes high gain, venues de la communauté, l’accompagnent.',
      ],
      points: [
        ['Metal', 'serré, rapide, précis'],
      ],
    },
    {
      id: 'pedals',
      eyebrow: 'Autour de l’ampli',
      title: 'Gate, boost, tone, pitch, reverb',
      body: ['Une chaîne courte dans un ordre fixe, réglée pour que le premier son soit déjà le bon.'],
      points: [
        ['Gate', 'le silence entre les notes'],
        ['Boost', 'des graves plus serrés'],
        ['Pitch', 'accorder plus bas sans mécaniques'],
        ['Reverb', 'de l’espace pour le solo'],
      ],
    },
    {
      id: 'cab',
      eyebrow: 'Baffle',
      title: 'Des baffles, ou votre propre IR',
      body: [
        'Chaque capture a son baffle. Chargez n’importe quelle réponse impulsionnelle depuis votre disque pour le remplacer : WAV, AIFF ou FLAC, convoluée dans la chaîne sans latence ajoutée.',
      ],
    },
  ],
  pair: [
    {
      id: 'tuner',
      eyebrow: 'Accordeur',
      title: 'Accordeur',
      body: ['Chromatique, au cent près, insensible à la latence. Accordez-vous sur le morceau avant la première prise.'],
    },
    {
      id: 'metronome',
      eyebrow: 'Métronome',
      title: 'Métronome',
      body: ['Tempo, signature, tap. Le clic n’entre jamais dans une boucle ni dans une prise.'],
    },
  ],
  banner: { line: 'Branchez. Jouez.', sub: 'La tab, le morceau, le son. Votre prise.' },
  requirements: {
    title: 'Configuration requise',
    items: [
      'Un ordinateur de bureau ou portable sous Windows, macOS ou Linux.',
      'Une interface audio, avec un pilote ASIO pour l’ASIO. Un câble guitare-USB fonctionne aussi.',
      'Un casque ou des enceintes, branchés sur l’interface.',
      'Tonecraft Engine pour l’ASIO sous Windows, CoreAudio sous macOS, ALSA sous Linux. Sans lui, Tonecraft joue dans le navigateur.',
    ],
    browsers: 'Navigateurs',
    head: ['Navigateur', 'Tonecraft Engine', 'Navigateur seul'],
    table: [
      ['Chrome / Edge', 'Oui', 'Oui'],
      ['Firefox', 'Oui', 'Oui, sortie par défaut'],
      ['Safari', 'Non', 'Oui, latence plus élevée'],
      ['Mobile', 'Non', 'Non'],
    ],
  },
  faq: {
    title: 'Questions',
    items: [
      ['De quoi ai-je besoin pour enregistrer une cover guitare ?', 'Une guitare, une interface et Tonecraft. Lecteur de tablatures, piste de fond, ampli et enregistreur sont sur la même page, et l’export est un WAV.'],
      ['Quelle latence ?', 'Avec Tonecraft Engine et l’ASIO, la plus basse que permet votre interface. Dans le navigateur seul, elle dépend du système. L’aller-retour est mesuré et toujours affiché.'],
      ['Tonecraft est-il gratuit ?', 'Oui. Pas de compte, pas d’abonnement, pas de version d’essai.'],
      ['Quels formats de tablature puis-je ouvrir ?', 'Guitar Pro 3 à 7, GPX, MusicXML, Capella et alphaTex. Les fichiers sont lus sur votre ordinateur, jamais envoyés.'],
      ['Faut-il installer quelque chose ?', 'Seulement Tonecraft Engine, pour l’ASIO, proposé dans les réglages audio du studio. Tout le reste est dans Tonecraft.'],
      ['Mon son est-il envoyé quelque part ?', 'Non. L’audio est traité sur votre ordinateur et n’en sort jamais.'],
      ['Peut-on partager un son ?', 'Oui. Un son est un lien : qui l’ouvre entend les mêmes réglages.'],
    ],
  },
  cta: { title: 'Votre prochaine cover commence ici.', body: 'Ouvrez le studio, branchez, chargez la tab.', open: 'Ouvrir le studio' },
  footer: { tagline: 'La boîte à outils tout-en-un pour vos covers guitare.', product: 'Produit', source: 'Code source', license: 'Tonecraft Engine est sous GPL-3.0.' },
  alt: {
    hero: 'La tête d’ampli GUILT dans Tonecraft, avec son vitrail violet',
    overview: 'Le studio Tonecraft : réglages globaux, tête d’ampli et outils de session',
    amp: 'La tête d’ampli GUILT et ses groupes de réglages',
    pedals: 'Les réglages de hauteur, de couleur du boost et de réverb, dans le panneau pédales de la bande chaîne',
    cab: 'Sélecteurs d’ampli et de baffle',
    session: 'Looper et enregistreur avec la forme d’onde d’une prise',
    tabs: 'Une tablature qui défile au-dessus d’un manche éclairé',
    tuner: 'L’accordeur chromatique',
    metronome: 'Le métronome',
    engine: 'Réglages audio de Tonecraft avec le choix ASIO',
    banner: 'La nef dans laquelle GUILT est photographié',
  },
};

export const LANDING: Record<LandingLocale, LandingCopy> = { en, fr };
