# Fonts

Archivo (variable: width 62-125, weight 400-900), IBM Plex Sans 400/500/600 and IBM Plex Mono 400/500/600, latin and latin-ext subsets, fetched on 2026-10-28 by `tools/fetch-fonts.mjs` from Google Fonts (https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap). `css/fonts.css` declares them; the page loads no third-party font stylesheet.

## Licence

All three are under the SIL Open Font License 1.1: free to use, bundle and serve, commercially too; not to be sold on their own; every copy keeps the copyright and the licence. The licence texts are `OFL-IBM-Plex.txt` (Copyright 2017 IBM Corp., with Reserved Font Name "Plex") and `OFL-Archivo.txt` (Copyright 2020 The Archivo Project Authors, no reserved name). These are Google Fonts' files, unchanged: a version modified here (re-subset, edited) could not keep the name "Plex".

## Text element fonts (`text/`)

The text element turns letters into geometry, so it needs the outlines themselves: TrueType files read by opentype.js (`vendor/opentype`, MIT), not the WOFF2 web fonts above. Fetched on 2026-11-06 from the Google Fonts CSS API asking without a browser user agent, which answers with static TrueType instances (https://fonts.googleapis.com/css2?family=Archivo:wght@800&family=IBM+Plex+Sans:wght@600&family=IBM+Plex+Mono:wght@600&family=Fredoka:wght@600&family=Bitter:wght@700&family=Pacifico&family=Bungee&display=swap):

| file | family, style | licence text |
|---|---|---|
| `archivo-800.ttf` | Archivo ExtraBold | `../OFL-Archivo.txt` |
| `ibm-plex-sans-600.ttf` | IBM Plex Sans SemiBold | `../OFL-IBM-Plex.txt` |
| `ibm-plex-mono-600.ttf` | IBM Plex Mono SemiBold | `../OFL-IBM-Plex.txt` |
| `fredoka-600.ttf` | Fredoka SemiBold | `OFL-fredoka.txt` (Copyright 2016 The Fredoka Project Authors) |
| `bitter-700.ttf` | Bitter Bold | `OFL-bitter.txt` (Copyright 2011 The Bitter Project Authors, Reserved Font Name "Bitter Pro") |
| `bungee-400.ttf` | Bungee Regular | `OFL-bungee.txt` (Copyright 2023 The Bungee Project Authors) |
| `pacifico-400.ttf` | Pacifico Regular | `OFL-pacifico.txt` (Copyright 2018 The Pacifico Project Authors) |

All SIL Open Font License 1.1 and unchanged, so they keep their names. The licence texts are from github.com/google/fonts (`ofl/<family>/OFL.txt`). `css/app.css` declares the same files as `fpt-*` font faces, only to show each font in its picker tile. The designs export geometry made from the outlines, which the OFL does not restrict.
