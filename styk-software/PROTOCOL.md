# Styk Bluetooth protocol, version 1

This is the contract between the tag firmware (`firmware/`) and the Styk app (`app/`).
Change both sides together and bump the version byte when the format changes.

## Identity printed on each sticker

| Item | Example | Notes |
| --- | --- | --- |
| Tag code | `7F3A` | 4 hex characters. Shown in pairing mode as the Bluetooth name `Styk-7F3A`. |
| PIN | `482915` | 6 digits. The phone asks for it the first time it pairs. |
| QR code | `https://thestyk.com/app/?tag=7F3A&pin=482915` | Opens the app with both filled in. |

Prototype firmware takes the code from the chip ID and prints the code, PIN and link on the serial console at start-up.
On the nRF52 development kit the PIN is always `123456`; other boards derive it from the chip ID.
Production tags get a random PIN and key at the factory (see "Before production" below).

## Modes

| Mode | When | Bluetooth name | Advertising interval |
| --- | --- | --- | --- |
| Pairing | No owner yet, or the owner released it | `Styk-XXXX` | 500 ms |
| Owned, near owner | Owner connected in the last 30 min | `Styk` | 2 s (10.24 s when battery is low) |
| Owned, separated | No owner contact for 30 min | `Styk` | same |

- The rotating ID changes every 15 minutes near the owner and every 24 hours once separated, following the IETF unwanted-tracker accessory draft.
- After 8 hours without the owner the tag chirps, then again every 8 hours, so a tag travelling with someone else can be found.
- One owner at a time. Pairing requests are refused while the tag has an owner.

## Advertising

Advertising data (31 bytes max):

- Flags: LE General Discoverable, BR/EDR not supported.
- Manufacturer specific data, 11 bytes:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 2 | Company ID, little endian. `0xFFFF` (test ID) until Styk has an assigned Bluetooth SIG ID |
| 2 | 1 | Payload version, `1` |
| 3 | 6 | Rotating ID: first 6 bytes of AES-128(device key, epoch as uint32 LE + separated flag + zero padding) |
| 9 | 1 | Battery percent, 0-100 |
| 10 | 1 | Flags: bit 0 charging, bit 1 low battery, bit 2 separated, bit 5 owned |

Scan response: the 128-bit service UUID and the complete local name (`Styk-XXXX` or `Styk`).

## GATT service

Service UUID `5a7e0001-6b1d-4c3a-9f2e-0a1b2c3d4e5f`. Every Styk characteristic requires PIN-authenticated pairing (security level 3).
Reading Info or Status is how the app triggers the phone's PIN prompt.

| Characteristic | UUID | Properties | Value |
| --- | --- | --- | --- |
| Alert | `5a7e0002-6b1d-4c3a-9f2e-0a1b2c3d4e5f` | Write | 1 byte: `0x00` stop, `0x01` find sound (about 10 s), `0x02` short chirp |
| Control | `5a7e0003-6b1d-4c3a-9f2e-0a1b2c3d4e5f` | Write | `0x10` release ownership; `0x30` + uint32 LE Unix time (set clock) |
| Status | `5a7e0004-6b1d-4c3a-9f2e-0a1b2c3d4e5f` | Read, Notify | 10 bytes, below |
| Info | `5a7e0005-6b1d-4c3a-9f2e-0a1b2c3d4e5f` | Read | 4 ASCII bytes: the tag code, so the app can confirm it reached the right tag |

Status, 10 bytes, little endian:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Version, `1` |
| 1 | 1 | Battery percent |
| 2 | 2 | Battery millivolts, 0 if unknown |
| 4 | 2 | Solar cell millivolts, 0 if not measured |
| 6 | 1 | Flags: bit 0 charging, bit 1 low battery, bit 2 separated, bit 3 sound playing, bit 4 clock set, bit 5 owned |
| 7 | 3 | Firmware version: major, minor, patch |

Standard services also present: Battery Service (`0x180F`) and Device Information (`0x180A`, firmware revision).

## App flow

1. Scan the QR code, or type the code and PIN.
2. Tap Connect. The browser shows Styk tags nearby; in pairing mode the list is filtered to `Styk-XXXX`.
3. The app reads Info. The phone asks for the PIN and pairs. The app checks that the code matches.
4. The app reads Status, subscribes to Status notifications and writes Control `0x30` with the current time.
5. Play sound writes Alert `0x01`; Stop writes `0x00`.
6. Remove writes Control `0x10`. The tag forgets its owner and returns to pairing mode.

## Before production

- Replace the fixed PIN with a per-tag secret. Zephyr warns that a fixed passkey can be worked out by someone recording a pairing. Plan: the QR code carries a 128-bit claim secret, and the app proves it knows the secret with a challenge-response before the tag accepts an owner.
- Write a random device key and PIN at the factory instead of deriving them from the chip ID.
- Get a Bluetooth SIG company ID and replace `0xFFFF`.
- Rotate the Bluetooth address on the same schedule as the rotating ID.
- Add the non-owner "play sound" command from the IETF unwanted-tracker draft, so someone who finds an unknown Styk travelling with them can make it ring.
- Background finding (other people's phones reporting a lost tag) needs native iPhone and Android apps or a platform finding network; a web page cannot scan in the background.
