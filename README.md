# Facelift

For a certain compact 37-key electric piano. Facelift can make its "Toy" setting play a hidden built-in acoustic piano
sound, and can set a custom velocity curve for each voice.

**[Open facelift →](https://dgoeke.github.io/facelift/)**

Expanded from [toy_piano_patcher](https://github.com/rchrd2/toy_piano_patcher) by [rchrd2](https://github.com/rchrd2).

Facelift is a single static webpage. You download a copy of the v1.30 firmware updater, choose your options,
and it modifies the official image by changing some of the data bytes, then flashes it to your keyboard. Everything
runs in your browser, and the page makes no network requests after it loads. No firmware is included here or ever sent
anywhere else.


## ⚠️ But, you know...

This is one guy's evening project for a couple nights. It's unofficial and isn't made or supported or endorsed by the
manufacturer. It's for your personal use on hardware you own. No warranty. I also used AI to help.

## Stuff you need

- A keyboard that's plugged into its AC adapter and USB to the computer
- The manufacturer's official v1.30 firmware updater. Facelift checks its SHA256 which must start with  `115cd5bbc80ec1d5`
  and rejects anything else.
- Chrome or Edge. Sorry. I use Firefox but web MIDI is just more reliable on Chrome.

## How to use it

Just do what it says. Okay here's what it will say:
1. Load official updater by dropping its folder into the box. Or press the button and select a folder. If you do it the 2nd
   way Chrome will warn that you're uploading a bunch of files, but they aren't leaving your computer. When the firmware file
   inside it is found, it says "recognised" in green.
2. Pick your options: real piano sound, custom curves, etc. Anything you don't check will keep the real firmware default.
   The curves tagged as default were read from the firmware when it loaded.
3. Put the keyboard in update mode by holding F# minor (F#, A, C#) in the middle of the keyboard when you turn it on.
4. Press the 'connect' button, give it permission to use MIDI, and pick the keyboard from the dropdown.
5. Hold your breath.
6. Press 'send'. It takes around 2.5 minutes. Keep the computer awake, don't unplug anything. Be cool.
7. Wait. The app will tell you when its done, but then the keyboard takes maybe 10 seconds longer. Look for all 6 of the red
   lights to come on. That means it worked. Powercycle it.

## Dealing with problems (don't worry this won't happen)

Restore the original unmodified v1.30 firmware using the updater you started with. If a flash stops halfway because
something got unplugged, the keyboard will still be in update mode. Just turn it off, enter update mode again, and flash agian.

If you press 'stop' we stop sending data, but we already probably sent a lot and we can't undo that. The data may be queued
and still going out for up to a minute after you press it (not in our control).

If the port happens to disappear after the full update was queued, we can't tell how much arrived. But don't switch it off,
wait to see if the 6 lights come on and it worked if they did. If they don't then flash again like described above.

## How does it work though

The updater's firmware is literally a MIDI file made of SysEx messages. Facelift reads it, puts the velocity curves and
the toy patch in the right places, fixes the checksums, then it decodes the whole thing from scratch again to make sure
only those bytes are different. Then it sends the messages 454.2 ms apart, just like the real updater.

## To run it locally

You really don't need to. [The published page](https://dgoeke.github.io/facelift/) is identical. But you can't just open
the .html file because the browser won't load its modules. So from its directory run `make dev` and open
<http://localhost:8000>.

## Tests

```bash
node --test
```

Some tests need the real firmware path set in `FACELIFT_SOURCE` and they'll get skipped if you don't set it.

## Licence

MIT. See [LICENSE](LICENSE).
