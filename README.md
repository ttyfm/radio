# ttyfm

Internet radio in your terminal. One file, no dependencies, and a grudge against silence.

ttyfm plays live radio through mpv and wraps it in a fast TUI: what's on now, an EQ that moves with the audio, favorites, listening history, yearly stats, and enough failover that a dying stream is the station's problem and not yours.

Claude-inspired design: the same bullets, tree branches and boxed prompt, so it fits next to the tools already in your terminal.

[Install](#install) · [Keys](#keys) · [Failover](#failover) · [Breaks](#breaks) · [Equalizer](#equalizer) · [Wrapped](#wrapped) · [Stations](#stations) · [Song titles](#song-titles) · [Data](#data) · [License](#license)

```
  ✳ tty.fm                                                  ● live
  ────────────────────────────────────────────────────────────────

  ⏺ Better Times - Robin Schulz / Barbz
  ⏺ Laweta - Kizo / Julia Wieniawa ♥

  ⏺ Dai Dai - Shakira / Burna Boy
    ⎿  ━━━━━━━━━━━━━━━━━━━━━━──────────────  1:34 / 2:28

  ○ Fly High - Toby Romeo (up next)

  ────────────────────────────────────────────────────────────────
  [RMF MAXX · RS202-KRK]                            ▂▃▅▇▆▃▂▁▂▄▆▅▃▂
  ⏵⏵ during breaks: hop stations (shift+tab to cycle)      vol 80
```

## Install

```sh
npm i -g ttyfm
```

Or clone the repo and run `node radio.js`.

You need Node 18 or newer and [mpv](https://mpv.io):

```sh
brew install mpv       # macOS
sudo apt install mpv   # Debian, Ubuntu
winget install mpv     # Windows
```

On Windows, run it in Windows Terminal.

ttyfm ships with no stations of its own. First launch opens discover, which lists the 144 built-in ones and searches 50,000 more, so you can add some.

## Keys

| Key      | Action                                         |
| -------- | ---------------------------------------------- |
| `space`  | pause / resume (resume rejoins the live edge)  |
| `m`      | mute (stream keeps rolling underneath)         |
| `↑ ↓`    | volume                                         |
| `← →`    | previous / next station                        |
| `1-9`    | jump to station by list order                  |
| `f`      | favorite the current song                      |
| `v`      | favorites list                                 |
| `h`      | history browser (favorite past songs with `f`) |
| `r`      | station picker                                 |
| `d`      | discover: search and add stations              |
| `w`      | wrapped: your listening stats                  |
| `s`      | settings                                       |
| `a`      | cycle audio mode (normal / bass / rave / night) |
| `⇧ tab`  | cycle break behavior (lower / mute / hop)       |
| `n`      | hop to another mirror manually                 |
| `q`      | quit                                           |

In the station picker (`r`): `enter` tunes, `d` adds, `x` removes, `p` pins to the top, `w` warms every station, `c` cools them again.

macOS media keys and AirPods gestures work too. Play and pause fade in and out, next and previous change station. You can channel surf from your earbuds.

## Failover

The part with the most work in it and the least proof it is there. When a stream dies or stalls, ttyfm starts a second muted mpv on the next best mirror, waits until audio is really flowing, jumps it to the live edge, then crossfades over about 300ms and kills the old one. Done right, you hear nothing.

A watchdog catches the quiet failures as well: a stream that stops moving gets hopped even when mpv still says everything is fine.

Station switching runs on the same code, which is why changing stations sounds like a crossfade instead of a gap.

## Breaks

Radio plays ads. ttyfm noticed. Pick what happens in settings:

- **lower**: fade down to 30% for the break, fade back up for music
- **mute**: silence until the songs return
- **hop**: find another station playing music and crossfade to it

Hop means your radio can walk out when the ads start and wander back after. No promises about what it gets up to in between.

Knowing a break is on needs playlist data, so this only works on stations that have it. See [Song titles](#song-titles).

## Equalizer

The bars are real. mpv runs an `astats` and `aspectralstats` filter chain and reports loudness and tone over IPC. Volume drives the height, bass lights up the left side, treble the right. It is not a full per band FFT, but every bar you see comes from the audio you are hearing.

## Wrapped

Press `w` for top songs, top artists, streaks, hours per month, your peak listening hour, and a vibe like "evening loyalist" or "night owl explorer". It is built from your local history, so it starts thin and gets better the longer you listen.

## Stations

Press `d`. The list starts on the 144 built-in stations, there because each one comes with a playlist API: elapsed time, up next, and the break detection behind ad-dodging. They are RMF's 128 Polish stations, Radio Paradise's 7, and the 9 FIP stations from Radio France. Type to narrow that list, and the same keystrokes search [radio-browser.org](https://radio-browser.org), a community stream directory of roughly 50,000 stations, no key and no account. The directory's own rows for those three are skipped, since the built-in ones carry more. Enter adds the one you picked and tunes to it. In the picker, `x` removes a station.

Results with the same name collapse into one entry and their URLs become that station's mirrors, which is what failover walks down. HLS streams rank last because they carry no song info.

Stations live in `~/.ttyfm/streams.json` and you can write them by hand:

```json
{
  "uid": "url:https://kexp-mp3-128.streamguys1.com/kexp128.mp3",
  "name": "KEXP",
  "flag": "🇺🇸",
  "mirrors": ["https://kexp-mp3-128.streamguys1.com/kexp128.mp3"]
}
```

`mirrors` is a list of stream URLs for the same station. ttyfm tests them at startup, ranks them by speed and past failures, and works down the list when things break. `uid` just has to be unique.

An optional numeric `id` marks a station as being in the rmfon.pl playlist API, which is where the progress bar, the up next row and break detection come from.

## Song titles

Two sources, and which one you get depends on the station.

Most stations send the current song inside the stream over Icecast or SHOUTcast, and ttyfm reads it from there. That covers the title, the artist, favorites, history and wrapped. It does not cover the progress bar or the up next row, because the stream sends a title and nothing else, and only when the song changes, so a station you just tuned into stays blank until the next track starts.

Every built-in station gets the full picture from its own broadcaster's playlist API, rmfon.pl, radioparadise.com or radiofrance.fr: time elapsed, what is next, and the break detection behind ad-dodging. In `streams.json` those carry a numeric `id` and a `src` naming which API answers for them, `rmf`, `rp` or `rf`.

HLS streams (`.m3u8`) carry nothing at all. They play, they just never say what.

## Data

Everything sits in `~/.ttyfm` as plain JSON you can read:

- `streams.json`, your stations
- `favorites.json`, songs you hearted
- `history.json`, every song you heard, which feeds wrapped
- `settings.json`, preferences, last station, volume

Upgrading ttyfm never touches that folder. If you used an older version that kept these next to `radio.js`, they get moved across on first launch.

No cloud, no account, no telemetry. Delete a file to reset that part. It is your radio.

## Disclaimer

ttyfm is an independent client and is not affiliated with, endorsed by, or connected to any radio station or broadcaster. It ships with no audio and no station of its own. It plays whatever streams you add by connecting straight to the stations' own servers, the same way a browser would. The built-in list is a listing of public stream addresses that RMF, Radio Paradise and Radio France publish themselves, nothing more, and none of them is affiliated with ttyfm. All streams, trademarks and content stay the property of their owners. The rest of the station listings come from radio-browser.org, which is not affiliated with ttyfm either. The interface takes visual cues from Claude Code, but ttyfm is not affiliated with or endorsed by Anthropic.

## License

MIT
