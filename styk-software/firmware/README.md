# Styk tag firmware 0.2.0

Runs on the Nordic nRF52832. Use the **nRF52 DK** (board PCA10040) to prototype before the Styk board exists.
On the DK, LED 1 blinks the sound pattern in place of the buzzer.

Status: compiles with no warnings for the nRF52 DK with Zephyr 3.7.0 (153 KB flash, 28 KB RAM). It has not been run on hardware yet.

## Fastest way to try it (no build tools)

1. Plug the nRF52 DK into your computer with USB. A drive called **JLINK** appears.
2. Drag `prebuilt/styk-nrf52dk-0.2.0.hex` onto that drive. The kit programs itself and restarts.
3. On an Android phone, open Chrome and go to **thestyk.com/app**, then tap **Add a Styk**.
4. Leave the tag code blank, name it, tap **Connect** and pick **Styk-XXXX** from the list.
5. When the phone asks for a PIN, enter **123456** (the fixed PIN for development kits).

Hold **Button 1** while pressing **RESET** to clear the owner and start pairing mode again.

To see the start-up messages (tag code, PIN, pairing link), open a serial terminal at 115200 baud,
for example the Serial Terminal app in nRF Connect for Desktop.

## Building it yourself

Install the nRF Connect SDK (versions 2.7 to 2.9 match Zephyr 3.7) with the nRF Connect extension for VS Code, then:

```
west build -b nrf52dk/nrf52832 path/to/firmware
west flash
```

For a battery-powered build without the serial console add `-DEXTRA_CONF_FILE=overlay-lowpower.conf`.

Newer SDKs (Zephyr 4.x) are handled in the code, but expect a few deprecation warnings there.

## What is in `src/main.c`

| Part | What it does |
| --- | --- |
| Identity | Tag code from the chip ID; PIN (123456 on the DK); key for the rotating ID |
| Pairing | PIN-authenticated pairing, one owner at a time, pairing refused while owned |
| Advertising | `Styk-XXXX` while waiting for an owner, then plain `Styk` with a rotating encrypted ID |
| Bluetooth service | Alert (sound), Control (release, set clock), Status, Info; see `../PROTOCOL.md` |
| Separation | After 30 minutes without the owner the ID rotates daily; after 8 hours the tag chirps |
| Battery | Reads the battery through the analog input in `boards/nrf52dk_nrf52832.overlay` (the DK's own supply voltage) |
| Charging | Flags "charging" when the battery voltage rises, the "solar charge good" signal from the technical document |

## Before this runs on the Styk board

- Make a board definition for the Styk circuit: buzzer pin, battery divider and solar-cell measurement.
- Set `VBAT_DIVIDER_NUM` and `VBAT_DIVIDER_DEN` to the resistor-divider ratio.
- Replace the fixed and derived PINs with factory-written secrets (see "Before production" in `../PROTOCOL.md`).
- Measure real power draw against the solar budget before promising "no charging".
