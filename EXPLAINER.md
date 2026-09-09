# Tonecraft, explained without the jargon

*For anyone who does not play guitar and wants to know what this thing actually is.*

---

## In one sentence

Tonecraft is a self-contained guitar rig that lives in a web page: you plug a
guitar into your computer, open a URL, and hear the sound of a real amplifier
and a small pedalboard — with nothing to install, buy, or configure.

## The problem it solves

An electric guitar on its own is almost silent. It makes a thin, woody,
unplugged sound — like a dry click. Everything people recognise as "electric
guitar" (the roar, the sustain, the growl) is not made by the guitar. It is
made by the equipment it is plugged into:

- an **amplifier**, a box that magnifies the signal so hard that it distorts on
  purpose — that distortion *is* the sound;
- a **speaker cabinet**, a wooden box with a speaker in it, which cuts off the
  harsh top end and gives the sound its body;
- a handful of **pedals**, small boxes on the floor between the guitar and the
  amp, each doing one job.

That gear costs money, takes up a room, and annoys the neighbours. So for
thirty years people have been simulating it in software instead. The catch is
that the software route has its own toll booth: you install a recording program,
install a plugin inside it, buy a licence, install an audio driver, and then
usually discover the sound arrives a beat late. Most people who just wanted to
play for twenty minutes never get past step two.

Tonecraft removes all of it. It is a link.

## What "standalone" means here

In audio software, a **plugin** is a component that cannot run by itself — it
needs a host program (a recording studio application) to live inside. A
**standalone** is the opposite: a program that runs on its own, with no host
around it. That is what Tonecraft is, except it goes one step further: the
"program" is a web page. Nothing is installed, nothing is downloaded, nothing
touches your system. Closing the tab is the uninstall.

Two consequences worth stating plainly:

- **No account, no server, no data.** Your sound never leaves your machine. The
  site is a set of static files; there is nothing on the other end to send
  audio to.
- **You do not need a guitar to use it.** The page can play a pre-recorded
  guitar performance through the same chain, so a visitor with no equipment
  still hears exactly what it sounds like — instantly, on a phone, with no
  microphone permission ever requested.

## What is inside the box

The signal travels through a fixed line of stages, in this order. Think of it
as a small factory: the raw, thin guitar signal goes in one end, and a finished
sound comes out the other.

```
guitar → In → Gate → Boost → Amp → Cabinet → Tone → Reverb → Out → headphones
```

| Stage | What it is | What it does, in plain terms |
|---|---|---|
| **In** | Input level | Sets how hard the signal hits everything downstream. On a high-distortion sound this controls bite and feel far more than loudness. |
| **Gate** | Noise gate | An automatic silencer. Heavy distortion amplifies hiss as enthusiastically as it amplifies notes; the gate mutes the chain when you are not actually playing, and opens the instant you do. Without one, high-gain sounds hiss constantly between phrases. |
| **Boost** | Overdrive pedal | A pedal that sits in front of the amp and pushes it harder while trimming the bass out first. Counter-intuitively, its job is *tightening*: it stops the low end turning to mud and sharpens the attack of each note. Modelled on the classic green overdrive pedal every guitarist owns. |
| **Amp** | The amplifier | The heart of it. Rather than recreating an amp from equations, Tonecraft plays back a **capture**: a neural-network snapshot of one real amplifier, recorded at one setting, that responds to your playing the way the original did. It is closer to a photograph of an amp than a drawing of one. |
| **Cabinet** | Speaker simulation | The wooden box and speaker. Not optional and not cosmetic: without it the sound is unbearably harsh, because a real speaker throws away almost everything above roughly 5 kHz. |
| **Tone** | Four-band equaliser | Bass / Mid / Treble / Presence. The final adjustment of the balance, applied after the speaker rather than before it — that ordering matters, and is the sort of detail the rest of the repository argues about at length. |
| **Reverb** | Reverb pedal | Adds the sense of a room. Purely dry distortion in headphones sits uncomfortably "inside your head" and tires the listener within minutes; a small amount of space gives held notes somewhere to go. Small, but never zero. |
| **Out** | Master volume + limiter | The final level, plus a safety stage that cannot be switched off anywhere in the interface. A runaway feedback loop in headphones can genuinely injure someone, so the limiter is not a feature the user gets to disable. |

Every stage except the amp, the cabinet and the output can be switched off
individually, so you can hear what each one contributes.

## Why "amp, reverb, gate, boost" is the whole list

The temptation with software is to ship a catalogue: forty amps, ninety pedals,
a thousand presets. Tonecraft deliberately does the opposite and ships **one**
finished sound. The reasoning is that the person this is built for has had a
guitar in their hands for ten minutes, is tired of hearing bare wood, and is
about to put it down. What they need is one good sound in one second — not a
shopping trip. The rule is *cut the width, never the depth*.

So the yardstick is not "does it beat the expensive competition on a spec
sheet". It is: does it beat the small practice amp in the corner of the room,
and does it beat putting the guitar back on its stand.

## The three hard constraints

Anyone reading the source will notice the project is unusually stubborn about
three numbers. They are worth understanding, because they explain most of the
design decisions.

1. **Processor cost.** Audio is computed in tiny chunks, roughly every 2.7
   milliseconds, and each chunk must be finished before the next is due. Miss
   the deadline and you do not get a slight delay — you get an audible click.
   Every click is a small reminder that this is software. So the budget is
   strict: under a quarter of one processor core on an average 2020 laptop.
2. **Sound quality.** The measure of success is that it sounds like software
   people pay for. In particular, distortion done carelessly generates false,
   metallic tones that were never in the signal — the single biggest reason
   cheap simulations sound cheap — and avoiding that is expensive, so it is
   paid for in the one place it is needed and nowhere else.
3. **Delay.** The gap between striking a string and hearing the result. It is
   listed third on purpose. Sound travels about 34 cm per millisecond, so
   standing three metres from a real amplifier already costs you about 9 ms and
   nobody has ever complained. Below 20 ms nothing is said; between 20 and 35
   the figure is shown and it is still playable; above that the page explains
   the hardware reason honestly and still lets you play. **A constant delay is
   forgotten within a minute; a delay that wobbles or crackles is unplayable
   forever** — so stability, not milliseconds, is the real target.

## What it is not

Not a recording studio. Not a multitrack recorder. Not a plugin, and not a host
for other people's plugins. Not a marketplace. Not a phone app. Each of those
is a legitimate product, and none of them is this one.

---

*Deeper reading, in increasing order of technicality: `PRODUCT.md` (who it is
for and why), `DESIGN.md` (how it looks and why), `README.md` (how to run it),
`CLAUDE.md` (the engineering rules that are not up for debate).*
