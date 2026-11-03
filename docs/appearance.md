# Appearance

On the Mac, open Settings › Appearance. On the phone, choose Appearance from
the overflow menu. Changes apply immediately. Done and swipe-down dismiss
the phone sheet without reverting anything.

## Mode

Light, Dark or System. System is the default and follows that device's
appearance, including changes while Kintsugi is open. An explicit Light or
Dark choice overrides the system across the app, popups and editor.

The Mac gallery uses miniature app captures. System combines the left half
of Light with the right half of Dark. The phone uses a segmented control
and one live text sample.

## Text

Text size scales the editor, not the rest of the interface. Both devices
use 80, 90, 100, 110, 120, 135 and 150%. The sample uses the selected size.
The Mac's ⌘−, ⌘= and ⌘0 still work while writing; hold ⌘ or open the keyboard
cheatsheet to find them.

Editor font is read-only: LT Superior Serif on the Mac and New York on iOS.
Colour themes and font choices are not shipped yet.

## Storage

Mode and size are per device, survive restarts, and never sync through the
vault or phone API. The Mac uses `kintsugi:appearance` and
`kintsugi:text-size` in localStorage. Unknown modes fall back to System;
invalid sizes fall back to 100%. The phone keeps mode and size together as
`settings:appearance` in its local SQLite key-value store.

The phone sheet starts around 520pt. Larger accessibility text opens a
larger detent, with scrolling when the content exceeds the available space.
