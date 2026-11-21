"""Send one key press to the X display in $DISPLAY through the XTest extension (TD-109).

Used by the e2e tests to dismiss Chromium's share picker (Escape), which Playwright cannot reach because the
picker is browser UI, not page content. Standard library only (ctypes + system libX11/libXtst).

Usage: python3 -I tests/support/xkey.py Escape
"""

import ctypes
import ctypes.util
import sys
import time


def load(name: str) -> ctypes.CDLL:
    path = ctypes.util.find_library(name) or f"lib{name}.so.6"
    return ctypes.CDLL(path)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: xkey.py KEYSYM_NAME", file=sys.stderr)
        return 2
    x11 = load("X11")
    xtst = load("Xtst")
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XStringToKeysym.restype = ctypes.c_ulong
    x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
    x11.XKeysymToKeycode.restype = ctypes.c_ubyte
    x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x11.XFlush.argtypes = [ctypes.c_void_p]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

    display = x11.XOpenDisplay(None)
    if not display:
        print("cannot open X display", file=sys.stderr)
        return 1
    try:
        keysym = x11.XStringToKeysym(sys.argv[1].encode("ascii"))
        keycode = x11.XKeysymToKeycode(display, keysym) if keysym else 0
        if not keycode:
            print(f"unknown key {sys.argv[1]}", file=sys.stderr)
            return 1
        xtst.XTestFakeKeyEvent(display, keycode, 1, 0)
        x11.XFlush(display)
        time.sleep(0.05)
        xtst.XTestFakeKeyEvent(display, keycode, 0, 0)
        x11.XFlush(display)
    finally:
        x11.XCloseDisplay(display)
    return 0


if __name__ == "__main__":
    sys.exit(main())
