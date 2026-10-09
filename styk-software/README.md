# Styk software 0.2.0

Everything that makes a Styk work: the tag firmware, the web app people use on their phone, and the protocol between them.

| Folder | What it is |
| --- | --- |
| `app/` | The Styk web app. Upload it to your website as `thestyk.com/app`. |
| `firmware/` | Firmware for the tag's chip (nRF52832), with a ready-to-load file for the nRF52 DK. |
| `PROTOCOL.md` | The Bluetooth contract between app and tag. Change both sides together. |
| `tests/` | Automated end-to-end tests for the app, including a simulated tag. |

This replaces the earlier `styk-firmware` and `styk-app` drafts.

## What the app does

- **Your tags.** A list of tags with status (connected, nearby, out of range), battery and last seen.
- **Play sound.** One tap connects if needed and makes the tag beep for about 10 seconds; tap again to stop.
- **Last seen.** Each time this phone sees a tag it saves the time and, if location is allowed, a map pin with directions.
- **Left-behind alert.** Warns you when the phone loses touch with a tag while the app is open.
- **Add a Styk.** Scan the QR code on the sticker with the phone camera, or type the code. The phone asks for the PIN once.
- **Remove.** Releases the tag so it can be added to another phone.
- **Demo tags.** Two pretend tags so anyone, including investors, can try the app with no hardware.
- **Private by design.** Tags and locations stay in that browser. There are no accounts and no server.
- **Installable.** It works offline and can be added to the home screen like an app.

## Put the app on thestyk.com

1. Unzip the download. Inside `styk-software` you'll find a folder called `app`.
2. In GitHub Desktop, choose **Repository → Show in Finder** to open your `thestyk` folder.
3. Drag the whole `app` folder into it, next to your `index.html` and `CNAME`.
4. Back in GitHub Desktop, type a summary such as "Add Styk app", click **Commit to main**, then **Push origin**.
5. After a minute or two, open **https://thestyk.com/app/** on your phone and tap **Try the demo tags**.

Only the `app` folder goes on the website. Keep `firmware`, `tests` and the `.md` files on your computer, or in a separate private repository.

## Which phones work

| Phone or computer | Demo | Real tags |
| --- | --- | --- |
| Android with Chrome | Yes | Yes |
| Windows, Mac, ChromeOS with Chrome or Edge | Yes | Yes |
| iPhone (Safari or Chrome) | Yes | Not yet: Apple doesn't allow websites to use Bluetooth |

Background finding needs native apps. Reporting a lost tag through other people's phones also needs native apps or a platform finding network; a web page can't scan in the background.

## Run the tests

```
pip install playwright
playwright install chromium
python3 tests/test_app.py
```

Seven checks run in a headless browser:

1. Demo flow.
2. Pairing link and simulated tag, checking each byte sent against `PROTOCOL.md`.
3. Wrong tag and bad PIN messages.
4. Blank code.
5. Browsers without Bluetooth.
6. Offline cache and dark mode.
7. Desktop layout.

Screenshots land in `tests/screenshots/`.

## Before launch

- The map uses OpenStreetMap's free tiles, which suit a prototype. For public launch switch to a paid tile provider (one line in `app/js/map.js`), since OpenStreetMap limits heavy use.
- Work through the "Before production" list in `PROTOCOL.md`: factory secrets, a Bluetooth company ID, address rotation and non-owner sound.
- Test with the nRF52 DK first; see `firmware/README.md`.
