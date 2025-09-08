# konami code webscript

Recently I ran into a problem where I had a bug, but I couldn't easily test it since I'd have to commit to see if something would change, this is because of a data difference between the live version and the local version. So that's why I made this Tampermonkey script to extract and import all local storage items. I also implemented this into my own websites. 

press `↑ ↑ ↓ ↓ ← → ← → B A` on any website to export all localstorage items to json
press `↑ ↑ ↓ ↓ ← → ← → A B` on any website to import all localstorage items from json, this clears localstorage beforehand.

It is called `Konami Script` because this sequence: `↑ ↑ ↓ ↓ ← → ← → B A` is called that. You can read more about that on [wikipedia](https://en.wikipedia.org/wiki/Konami_Code). I found this an elegant way to easily access debug files. In the future I might add session-storage to it as well, but that's a future thing, for when I need it.

Though if you now do it on [my website](https://oldmartijntje.nl), it'll result into giving you 2 jsons, if you have the plugin installed.