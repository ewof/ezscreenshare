ezscreenshare (Linux host)

This is only the desktop host. Viewers just open the link in a browser.

  chmod +x ezscreenshare
  ./ezscreenshare

If Linux refuses to start (sandbox helper / chrome-sandbox):

  ./ezscreenshare --no-sandbox

On first launch, paste the server URL (whoever runs the server tells you).
The host key is on the next screen. Change the server later from the menu: Server…

System audio uses PipeWire (pactl). Headset/speakers stay on your default sink.
